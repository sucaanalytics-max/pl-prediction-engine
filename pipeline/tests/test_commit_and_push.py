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


class _RepoHarness(unittest.TestCase):
    """
    A real remote and a real work tree per test.

    Split out from the test cases so a second suite can reuse the fixture without
    also re-running the first suite's assertions — subclassing a TestCase
    inherits its test methods, which would report every parent failure twice and
    obscure which suite actually broke.
    """

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


class CommitAndPushTests(_RepoHarness):
    """Drives the real script against real temporary repositories."""

    def test_usage_error_exits_two(self):
        self.assertEqual(self._run("only-a-message").returncode, 2)

    def test_a_pathspec_that_does_not_exist_yet_exits_zero(self):
        """
        `git add` exits 128 on a pathspec matching nothing, which under set -e
        aborted the whole job. On the agent's first run — or any run whose phase
        writes no artifact — predictions/fpl does not exist yet. That is not a
        failure.
        """
        # setUp creates the directory, so remove it to reach the real case.
        (self.work / "predictions" / "fpl").rmdir()
        result = self._run("nothing", "predictions/fpl")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No matching paths exist yet", result.stdout)

    def test_exclude_only_pathspecs_do_not_count_as_present(self):
        result = self._run("nothing", ":(exclude)predictions/fpl")
        self.assertEqual(result.returncode, 0, result.stderr)

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


class GlobPathspecTests(_RepoHarness):
    """
    The agent stages ``predictions/fpl/decision_gw*.json``, and the whole fix
    rests on a subtlety: the script's presence filter is ``[ -e "$pathspec" ]``,
    a *literal* file test that a glob pattern would never satisfy. It works only
    because the workflow's ``run:`` block is bash, so bash expands the glob before
    the script ever sees it.

    That makes the behaviour a property of the invocation, not of the script — so
    these tests must go through a shell. The parent class passes an argv list to
    subprocess, which performs no expansion and would therefore test the wrong
    thing while looking correct.
    """

    def _run_via_shell(self, message, *pathspecs, env_extra=None):
        env = {
            **os.environ,
            "PUSH_ATTEMPTS": "2",
            "PUSH_RETRY_DELAY": "0",
            "TARGET_BRANCH": "main",
        }
        env.update(env_extra or {})
        # Mirrors GitHub Actions: `bash -eo pipefail` running the same line the
        # workflow contains, pathspecs unquoted so the shell expands them.
        command = f'bash {SCRIPT} "{message}" ' + " ".join(pathspecs)
        return subprocess.run(
            ["bash", "-eo", "pipefail", "-c", command],
            cwd=self.work,
            env=env,
            capture_output=True,
            text=True,
        )

    def test_an_unmatched_glob_exits_zero_rather_than_failing_the_job(self):
        """
        The agent's first run, and every run before a decision is written.

        With no match, bash leaves the pattern literal, `[ -e ]` rejects it, and
        the script reports nothing to do. If bash had `failglob` or `nullglob`
        set this would behave differently, which is why it is asserted rather
        than reasoned about.
        """
        result = self._run_via_shell(
            "FPL agent", "predictions/fpl/decision_gw*.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No matching paths exist yet", result.stdout)

    def test_a_matched_glob_actually_commits_the_decision(self):
        """
        The bug this replaces: `decision_latest.json` was staged, nothing wrote
        it, the pathspec was filtered out as absent, and the job reported a clean
        publish having committed nothing. A green run that published nothing.
        """
        (self.work / "predictions" / "fpl" / "decision_gw07_season.json").write_text("{}")
        result = self._run_via_shell(
            "FPL agent", "predictions/fpl/decision_gw*.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        files = _git("show", "--name-only", "--format=", "main", cwd=self.remote).stdout
        self.assertIn("predictions/fpl/decision_gw07_season.json", files)

    def test_both_entries_are_committed_not_just_the_first(self):
        """
        Two mandates means two files per gameweek. Bash expands to two arguments
        and both must survive the presence filter — a `${1}`-style bug would
        publish the season team and silently drop the weekly one.
        """
        fpl = self.work / "predictions" / "fpl"
        (fpl / "decision_gw07_season.json").write_text("{}")
        (fpl / "decision_gw07_weekly.json").write_text("{}")
        result = self._run_via_shell(
            "FPL agent", "predictions/fpl/decision_gw*.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        files = _git("show", "--name-only", "--format=", "main", cwd=self.remote).stdout
        self.assertIn("decision_gw07_season.json", files)
        self.assertIn("decision_gw07_weekly.json", files)

    def test_the_phantom_filename_would_have_committed_nothing(self):
        """
        The bug, demonstrated. Written as a test so the regression is documented
        as behaviour rather than as a comment: with a real decision on disk, the
        old pathspec publishes nothing and still exits 0.
        """
        (self.work / "predictions" / "fpl" / "decision_gw07_season.json").write_text("{}")
        result = self._run_via_shell(
            "FPL agent", "predictions/fpl/decision_latest.json",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No matching paths exist yet", result.stdout)

        log = _git("log", "--oneline", "--format=%s", "main", cwd=self.remote).stdout
        self.assertNotIn("FPL agent", log)


if __name__ == "__main__":
    unittest.main()
