"""
Tests for the Vercel build gate and the bots' half of it.

  frontend/scripts/vercel-ignore.sh    — Vercel's ignoreCommand (exit 0 skips)
  .github/scripts/deploy_marker.sh     — when a bot commit asks for a build
  frontend/scripts/bot-commits.sh      — the one definition both read

The two scripts fail in opposite directions, and both directions are silent.
A gate that skips too much leaves real code undeployed with a green dashboard;
a marker that never fires leaves the site on a stale build, because the
published predictions are static files baked into each deployment. So the exit
codes and the exact message suffix are pinned here.
"""
import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
IGNORE = ROOT / "frontend" / "scripts" / "vercel-ignore.sh"
MARKER = ROOT / ".github" / "scripts" / "deploy_marker.sh"

# One real subject per bot writer, as the workflows format them.
BOT_SUBJECTS = [
    "Availability news — 2026-10-18T16:42Z",
    "FPL agent — refresh GW7",
    "FPL agent — seal GW7",
    "FPL agent — settle_final GW6",
    "FPL agent — refit GW7",
    "Agent status — refresh GW7",
    "Agent status — idle GW8",
    "Agent status — settle_final GW6",
    "Update predictions — 2026-10-18",
    "Update model health — 2026-10-18",
    "X scan — 2026-10-18T09:00Z",
]


def _git(*args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
    )


def _env(**extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith("VERCEL_")}
    env.update(extra)
    return env


class _Repo(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.work = self.root / "work"
        _git("init", "--initial-branch=main", str(self.work), cwd=self.root)
        _git("config", "user.name", "Test", cwd=self.work)
        _git("config", "user.email", "test@example.invalid", cwd=self.work)
        self._commit("base", {"README.md": "base\n"})

    def _commit(self, message, files):
        for rel, body in files.items():
            path = self.work / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body)
            _git("add", rel, cwd=self.work)
        _git("commit", "-q", "--allow-empty", "-m", message, cwd=self.work)


class VercelIgnoreTests(_Repo):
    """Exit 0 = Vercel skips the build. Exit 1 = Vercel builds."""

    def _gate(self, message=None):
        env = _env() if message is None else _env(VERCEL_GIT_COMMIT_MESSAGE=message)
        return subprocess.run(
            ["bash", str(IGNORE)], cwd=self.work, env=env,
            capture_output=True, text=True,
        )

    def test_every_bot_subject_is_skipped(self):
        for subject in BOT_SUBJECTS:
            with self.subTest(subject=subject):
                result = self._gate(subject)
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertIn("SKIP", result.stdout)

    def test_deploy_token_builds_even_a_bot_commit(self):
        result = self._gate("Availability news — 2026-10-18T16:42Z [deploy]")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("BUILD", result.stdout)

    def test_deploy_token_in_the_body_also_builds(self):
        result = self._gate("Fix a typo\n\nShip it now [deploy]")
        self.assertEqual(result.returncode, 1, result.stdout)

    def test_a_code_commit_builds(self):
        self._commit("Tidy the stats page", {"frontend/app/stats/page.tsx": "x\n"})
        result = self._gate("Tidy the stats page")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("frontend/app/stats/page.tsx", result.stdout)

    def test_a_human_commit_touching_only_data_is_skipped(self):
        self._commit("Hand-fix a fixture", {
            "predictions/latest.json": "{}\n",
            "frontend/public/predictions/latest.json": "{}\n",
        })
        result = self._gate("Hand-fix a fixture")
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_mixed_data_and_code_builds(self):
        self._commit("Ship a field", {
            "frontend/public/predictions/latest.json": "{}\n",
            "frontend/lib/data/narrow.ts": "x\n",
        })
        self.assertEqual(self._gate("Ship a field").returncode, 1)

    def test_a_lookalike_path_is_not_data(self):
        # `frontend/public/predictions-old/` must not ride the data prefix.
        self._commit("Move", {"frontend/public/predictions-old/a.json": "{}\n"})
        self.assertEqual(self._gate("Move").returncode, 1)

    def test_only_the_subject_is_matched_against_bot_patterns(self):
        self._commit("Revert the poller", {"pipeline/learning/run_news.py": "x\n"})
        message = "Revert the poller\n\nThis reverts Availability news — 2026-10-18T16:42Z"
        self.assertEqual(self._gate(message).returncode, 1)

    def test_an_unknown_phase_builds(self):
        # A new phase is a new code path; fail toward building.
        self._commit("x", {"frontend/app/page.tsx": "x\n"})
        self.assertEqual(self._gate("FPL agent — newphase GW7").returncode, 1)

    def test_a_root_commit_builds(self):
        # No HEAD^ (a shallow clone looks the same): cannot prove data-only.
        self.assertEqual(self._gate("base").returncode, 1)

    def test_falls_back_to_git_log_without_the_vercel_variable(self):
        self._commit("Update predictions — 2026-10-18", {"predictions/latest.json": "{}\n"})
        result = self._gate(None)
        self.assertEqual(result.returncode, 0, result.stdout)


class DeployMarkerTagTests(unittest.TestCase):
    """`tag` prints the message, plus " [deploy]" when a build is due."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fixtures = Path(self.tmp.name)

    def _recent(self, *lines):
        (self.fixtures / "recent.tsv").write_text("".join(f"{l}\n" for l in lines))

    def _tag(self, message, *flags):
        return subprocess.run(
            ["bash", str(MARKER), "tag", message, *flags],
            env=_env(DEPLOY_MARKER_FIXTURE_DIR=str(self.fixtures)),
            capture_output=True, text=True,
        )

    def test_tags_when_only_skipped_bot_commits_are_recent(self):
        self._recent(
            "false\tAvailability news — 2026-10-18T16:42Z",
            "false\tAgent status — refresh GW7",
        )
        out = self._tag("FPL agent — refresh GW7")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout, "FPL agent — refresh GW7 [deploy]\n")

    def test_tags_when_nothing_happened_in_the_window(self):
        self._recent()
        self.assertEqual(
            self._tag("Update predictions — 2026-10-19").stdout,
            "Update predictions — 2026-10-19 [deploy]\n",
        )

    def test_does_not_tag_after_a_recent_tagged_build(self):
        self._recent(
            "false\tAvailability news — 2026-10-18T16:42Z",
            "true\tAgent status — refresh GW7 [deploy]",
        )
        self.assertEqual(
            self._tag("FPL agent — refresh GW7").stdout, "FPL agent — refresh GW7\n",
        )

    def test_a_recent_human_commit_counts_as_a_build(self):
        self._recent("false\tFix the stats page")
        self.assertEqual(
            self._tag("FPL agent — refresh GW7").stdout, "FPL agent — refresh GW7\n",
        )

    def test_force_always_tags(self):
        self._recent("true\tAgent status — refresh GW7 [deploy]")
        self.assertEqual(
            self._tag("FPL agent — seal GW7", "--force").stdout,
            "FPL agent — seal GW7 [deploy]\n",
        )

    def test_api_failure_tags_rather_than_withholds(self):
        # No recent.tsv: the fixture read fails exactly as an API error would.
        out = self._tag("FPL agent — refresh GW7")
        self.assertEqual(out.returncode, 0)
        self.assertEqual(out.stdout, "FPL agent — refresh GW7 [deploy]\n")

    def test_an_already_tagged_message_is_not_double_tagged(self):
        self._recent()
        self.assertEqual(self._tag("X scan — 2026-10-18T09:00Z [deploy]").stdout,
                         "X scan — 2026-10-18T09:00Z [deploy]\n")


class DeployMarkerFlushTests(_Repo):
    """`flush` pushes an empty [deploy] commit only when data is pending and due."""

    def setUp(self):
        super().setUp()
        self.remote = self.root / "remote.git"
        self.fixtures = self.root / "fixtures"
        self.fixtures.mkdir()
        _git("init", "--bare", "--initial-branch=main", str(self.remote), cwd=self.root)
        _git("remote", "add", "origin", str(self.remote), cwd=self.work)
        _git("push", "-q", "-u", "origin", "main", cwd=self.work)

    def _api(self, head, *recent):
        (self.fixtures / "head.tsv").write_text(f"{head}\n")
        (self.fixtures / "recent.tsv").write_text("".join(f"{l}\n" for l in recent))

    def _flush(self):
        return subprocess.run(
            ["bash", str(MARKER), "flush"], cwd=self.work,
            env=_env(DEPLOY_MARKER_FIXTURE_DIR=str(self.fixtures),
                     PUSH_ATTEMPTS="1", PUSH_RETRY_DELAY="0", TARGET_BRANCH="main"),
            capture_output=True, text=True,
        )

    def _remote_subject(self):
        return _git("log", "-1", "--format=%s", "main", cwd=self.remote).stdout.strip()

    def test_pushes_when_pending_and_overdue(self):
        self._api("false\tAvailability news — 2026-10-18T16:42Z")
        out = self._flush()
        self.assertEqual(out.returncode, 0, out.stderr)
        subject = self._remote_subject()
        self.assertTrue(subject.startswith("Deploy pending data — "), subject)
        self.assertTrue(subject.endswith(" [deploy]"), subject)
        # And the gate must agree that it builds.
        gate = subprocess.run(
            ["bash", str(IGNORE)], cwd=self.work,
            env=_env(VERCEL_GIT_COMMIT_MESSAGE=subject), capture_output=True, text=True,
        )
        self.assertEqual(gate.returncode, 1, gate.stdout)

    def test_never_publishes_what_is_left_staged(self):
        # commit_and_push.sh stages before checking FORBID_PATHS, so a refused
        # path is still in the index when this `if: always()` step runs.
        (self.work / "predictions").mkdir()
        (self.work / "predictions" / "latest.json").write_text("{}\n")
        _git("add", "predictions/latest.json", cwd=self.work)
        self._api("false\tAvailability news — 2026-10-18T16:42Z")
        out = self._flush()
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertTrue(self._remote_subject().startswith("Deploy pending data — "))
        files = _git("show", "--name-only", "--format=", "main", cwd=self.remote).stdout
        self.assertEqual(files.strip(), "")

    def test_waits_when_a_build_is_recent(self):
        self._api(
            "false\tAvailability news — 2026-10-18T16:42Z",
            "false\tAvailability news — 2026-10-18T16:42Z",
            "true\tFPL agent — refresh GW7 [deploy]",
        )
        self._flush()
        self.assertEqual(self._remote_subject(), "base")

    def test_does_nothing_when_the_newest_commit_builds(self):
        self._api("true\tFPL agent — refresh GW7 [deploy]")
        self._flush()
        self.assertEqual(self._remote_subject(), "base")

    def test_api_failure_never_pushes(self):
        out = self._flush()  # no fixtures written
        self.assertEqual(out.returncode, 0)
        self.assertEqual(self._remote_subject(), "base")


class WorkflowWiringTests(unittest.TestCase):
    """The gate is inert unless vercel.json names it and the bots call the marker."""

    def test_vercel_json_names_the_gate(self):
        import json
        config = json.loads((ROOT / "frontend" / "vercel.json").read_text())
        self.assertEqual(config.get("ignoreCommand"), "bash scripts/vercel-ignore.sh")

    def test_every_scheduled_writer_routes_its_message_through_the_marker(self):
        for name in ("news.yml", "pipeline.yml", "validate.yml", "fpl_agent.yml"):
            with self.subTest(workflow=name):
                text = (ROOT / ".github" / "workflows" / name).read_text()
                self.assertIn("deploy_marker.sh tag", text)
                self.assertIn("GH_TOKEN: ${{ github.token }}", text)

    def test_seal_and_settle_final_force_a_build(self):
        text = (ROOT / ".github" / "workflows" / "fpl_agent.yml").read_text()
        self.assertIn('seal|settle_final) FORCE="--force"', text)

    def test_the_news_job_flushes(self):
        text = (ROOT / ".github" / "workflows" / "news.yml").read_text()
        self.assertIn("deploy_marker.sh flush", text)


if __name__ == "__main__":
    unittest.main()
