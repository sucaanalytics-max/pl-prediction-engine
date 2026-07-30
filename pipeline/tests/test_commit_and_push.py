"""
Tests for .github/scripts/commit_and_push.sh.

The script replaces inline workflow bash whose retry loop ended on `sleep 5`,
so when every push attempt failed the step still exited 0 and the generated
commit was silently discarded. These tests pin the exit codes, because that
failure is invisible in the CI log — a green run that published nothing.
"""
import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPT = (
    Path(__file__).resolve().parents[2] / ".github" / "scripts" / "commit_and_push.sh"
)


def _git(*args, cwd, check=True):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


class CommitAndPushTests(unittest.TestCase):
    """Drives the real script against real temporary repositories."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)

        self.remote = root / "remote.git"
        self.work = root / "work"

        _git("init", "--bare", "--initial-branch=main", str(self.remote), cwd=root)
        _git("init", "--initial-branch=main", str(self.work), cwd=root)
        _git("config", "user.name", "Test", cwd=self.work)
        _git("config", "user.email", "test@example.invalid", cwd=self.work)
        _git("remote", "add", "origin", str(self.remote), cwd=self.work)

        # A base commit, so `pull --rebase origin main` has something to track.
        (self.work / "README.md").write_text("base\n")
        _git("add", "README.md", cwd=self.work)
        _git("commit", "-m", "base", cwd=self.work)
        _git("push", "-u", "origin", "main", cwd=self.work)

        (self.work / "predictions").mkdir()
        (self.work / "predictions" / "fpl").mkdir()

    def _run(self, *args, env_extra=None):
        env = {
            **os.environ,
            "PUSH_ATTEMPTS": "2",
            "PUSH_RETRY_DELAY": "0",
            "TARGET_BRANCH": "main",
        }
        env.update(env_extra or {})
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=self.work,
            env=env,
            capture_output=True,
            text=True,
        )

    def test_usage_error_exits_two(self):
        self.assertEqual(self._run("only-a-message").returncode, 2)

    def test_nothing_to_commit_exits_zero(self):
        result = self._run("nothing", "predictions")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Nothing to commit", result.stdout)

    def test_successful_publish_lands_on_the_remote(self):
        (self.work / "predictions" / "latest.json").write_text('{"a":1}')
        result = self._run("Update predictions", "predictions")
        self.assertEqual(result.returncode, 0, result.stderr)

        remote_head = _git("rev-parse", "main", cwd=self.remote).stdout.strip()
        local_head = _git("rev-parse", "HEAD", cwd=self.work).stdout.strip()
        self.assertEqual(remote_head, local_head)
        files = _git("show", "--name-only", "--format=", "main", cwd=self.remote)
        self.assertIn("predictions/latest.json", files.stdout)

    def test_failed_push_exits_nonzero_rather_than_reporting_success(self):
        """The regression this script exists for."""
        (self.work / "predictions" / "latest.json").write_text('{"a":1}')
        _git(
            "remote", "set-url", "origin",
            str(Path(self.tmp.name) / "does-not-exist.git"),
            cwd=self.work,
        )
        result = self._run("Update predictions", "predictions")
        self.assertEqual(result.returncode, 1)
        self.assertIn("nothing was published", result.stderr)
        # The commit exists locally; only publication failed.
        self.assertEqual(
            _git("log", "--oneline", "-1", "--format=%s", cwd=self.work).stdout.strip(),
            "Update predictions",
        )

    def test_forbidden_path_is_refused_before_committing(self):
        """Path ownership is what keeps two writers to one branch safe."""
        (self.work / "predictions" / "fpl" / "decision_gw01.json").write_text("{}")
        result = self._run(
            "Update predictions",
            "predictions",
            env_extra={"FORBID_PATHS": "^predictions/fpl/"},
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("forbidden pattern", result.stderr)
        # Nothing was committed, so the working tree is still recoverable.
        self.assertEqual(
            _git("log", "--oneline", "-1", "--format=%s", cwd=self.work).stdout.strip(),
            "base",
        )

    def test_exclude_pathspec_keeps_agent_paths_out(self):
        """The daily job's real invocation shape."""
        (self.work / "predictions" / "latest.json").write_text('{"a":1}')
        (self.work / "predictions" / "fpl" / "decision_gw01.json").write_text("{}")
        result = self._run(
            "Update predictions",
            "predictions",
            ":(exclude)predictions/fpl",
            env_extra={"FORBID_PATHS": "^predictions/fpl/"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        files = _git("show", "--name-only", "--format=", "main", cwd=self.remote).stdout
        self.assertIn("predictions/latest.json", files)
        self.assertNotIn("predictions/fpl/", files)

    def test_recovers_when_the_remote_moved_ahead(self):
        """A concurrent writer must cause a rebase, not a hard failure."""
        other = Path(self.tmp.name) / "other"
        _git("clone", str(self.remote), str(other), cwd=Path(self.tmp.name))
        _git("config", "user.name", "Other", cwd=other)
        _git("config", "user.email", "other@example.invalid", cwd=other)
        (other / "unrelated.txt").write_text("concurrent\n")
        _git("add", "unrelated.txt", cwd=other)
        _git("commit", "-m", "concurrent write", cwd=other)
        _git("push", cwd=other)

        (self.work / "predictions" / "latest.json").write_text('{"a":1}')
        result = self._run("Update predictions", "predictions")
        self.assertEqual(result.returncode, 0, result.stderr)

        log = _git("log", "--oneline", "--format=%s", "main", cwd=self.remote).stdout
        self.assertIn("Update predictions", log)
        self.assertIn("concurrent write", log)


if __name__ == "__main__":
    unittest.main()
