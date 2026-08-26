"""
The sealed ledger's frozen-input digest, and the fact that something now reads it.

`ledger.freeze_inputs` gzips the bootstrap beside each seal and records its digest in
the forecast header. `ledger.load_frozen_bootstrap` reads it back and refuses on a
mismatch, with a docstring promising that a gameweek with missing or altered frozen
inputs is "treated as unscoreable rather than reconstructed from live data".

That function had zero production callers. The digest was written on every seal and
compared to nothing, so the promise was never enforced by any running code — the
producer side worked and the verifier was decoration.

These tests pin the verifier's THREE verdicts on a ledger built in a temp directory,
and one of them (`test_a_tampered_seal_is_reported`) is the case that matters: it
mutates the frozen bytes and requires the check to notice. The real
`predictions/fpl/ledger` is never touched here — it is a sealed record and these
tests must be able to run without it.
"""
import gzip
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.learning.ledger import digest_bytes
from pipeline.validation.run_validation import verify_sealed_ledger


def seal(root: Path, gameweek: int, *, frozen: bool = True, payload=b'{"ok": 1}'):
    """A minimal sealed week: a forecast header plus its frozen inputs."""
    week = root / "fpl" / "ledger" / f"gw{gameweek:02d}"
    (week / "inputs").mkdir(parents=True, exist_ok=True)
    header = {"gameweek": gameweek}
    if frozen:
        blob = gzip.compress(payload)
        (week / "inputs" / "bootstrap.json.gz").write_bytes(blob)
        header["frozen_inputs"] = {
            "path": "bootstrap.json.gz",
            "digest": digest_bytes(blob),
        }
    (week / "forecast.jsonl").write_text(json.dumps(header) + "\n", encoding="utf-8")
    return week


class TestVerifySealedLedger(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_an_intact_seal_verifies(self):
        seal(self.root, 1)
        self.assertEqual(verify_sealed_ledger(self.root), {"gw01": "verified"})

    def test_a_tampered_seal_is_reported(self):
        # The whole point. Rewrite the frozen bytes and leave the header's digest
        # alone: this is what a silent re-projection against different data looks
        # like on disk, and before this check nothing in the repo could see it.
        week = seal(self.root, 1)
        (week / "inputs" / "bootstrap.json.gz").write_bytes(gzip.compress(b'{"ok": 2}'))
        verdict = verify_sealed_ledger(self.root)["gw01"]
        self.assertTrue(verdict.startswith("FAILED"), verdict)
        self.assertIn("digest mismatch", verdict)

    def test_a_missing_frozen_file_is_reported(self):
        week = seal(self.root, 1)
        (week / "inputs" / "bootstrap.json.gz").unlink()
        verdict = verify_sealed_ledger(self.root)["gw01"]
        self.assertTrue(verdict.startswith("FAILED"), verdict)
        self.assertIn("unscoreable", verdict)

    def test_a_seal_predating_freeze_inputs_is_neither_pass_nor_fail(self):
        # It must not read as verified — there is nothing to verify — and it must not
        # read as a failure either, or every historical week would alarm forever.
        seal(self.root, 1, frozen=False)
        self.assertEqual(
            verify_sealed_ledger(self.root), {"gw01": "no frozen inputs recorded"}
        )

    def test_an_unreadable_header_is_reported_rather_than_raised(self):
        week = seal(self.root, 1)
        (week / "forecast.jsonl").write_text("not json\n", encoding="utf-8")
        self.assertIn("unreadable header", verify_sealed_ledger(self.root)["gw01"])

    def test_every_sealed_week_is_checked_not_just_the_first(self):
        seal(self.root, 1)
        week2 = seal(self.root, 2)
        (week2 / "inputs" / "bootstrap.json.gz").write_bytes(gzip.compress(b"other"))
        verdicts = verify_sealed_ledger(self.root)
        self.assertEqual(verdicts["gw01"], "verified")
        self.assertTrue(verdicts["gw02"].startswith("FAILED"), verdicts)

    def test_no_ledger_at_all_is_empty_rather_than_an_error(self):
        # A fresh checkout has no seals. Validation must still run.
        self.assertEqual(verify_sealed_ledger(self.root), {})

    def test_it_writes_nothing_into_the_ledger(self):
        # The sealed record is read-only. A verifier that touched it would be the
        # very thing the seal exists to prevent.
        seal(self.root, 1)
        ledger = self.root / "fpl" / "ledger"
        before = {p: p.stat().st_mtime_ns for p in sorted(ledger.rglob("*")) if p.is_file()}
        digests = {p: digest_bytes(p.read_bytes()) for p in before}
        verify_sealed_ledger(self.root)
        after = {p: p.stat().st_mtime_ns for p in sorted(ledger.rglob("*")) if p.is_file()}
        self.assertEqual(set(before), set(after), "a file appeared or vanished")
        self.assertEqual(
            digests, {p: digest_bytes(p.read_bytes()) for p in after},
            "the verifier altered a sealed file",
        )


class TestTheRealLedger(unittest.TestCase):
    def test_every_sealed_week_on_disk_verifies(self):
        # The committed record, checked as it stands. If this ever fails, a sealed
        # week's frozen inputs no longer match what was sealed — which is the
        # condition the whole ledger exists to make detectable.
        ledger = Path("predictions/fpl/ledger")
        if not ledger.is_dir():
            self.skipTest("no ledger in this checkout")
        verdicts = verify_sealed_ledger(Path("predictions"))
        bad = {k: v for k, v in verdicts.items() if v.startswith("FAILED")}
        self.assertEqual(bad, {}, f"sealed weeks failed verification: {bad}")


if __name__ == "__main__":
    unittest.main()
