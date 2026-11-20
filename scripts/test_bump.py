import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("bump", Path(__file__).with_name("bump.py"))
bump = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bump)


class ReleaseTests(unittest.TestCase):
    def test_notes_include_only_current_entry_and_sha_pin(self):
        sha = "a" * 40
        notes = bump.release_notes(
            "# Changelog\n\n## v0.3.1 (2026-11-20)\n\n### Fix\n\n- Fix it\n\n"
            "## [0.3.0] - 2026-05-26\n\nOld entry\n", "0.3.1", sha,
        )
        self.assertIn("- Fix it", notes)
        self.assertNotIn("Old entry", notes)
        self.assertIn(f"Commit: {sha}", notes)
        self.assertIn(f"uses: keycardai/gha-keycard-auth@{sha} # v0.3.1", notes)

    def test_missing_entry_fails(self):
        with self.assertRaises(ValueError):
            bump.release_notes("# Changelog\n", "0.3.1", "a" * 40)

    def test_publish_creates_release_only_when_absent(self):
        for existing in (True, False):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as directory:
                cwd = Path(directory)
                (cwd / "CHANGELOG.md").write_text("## v0.3.1 (2026-11-20)\n\n- Fix it\n")
                results = [subprocess.CompletedProcess([], 0 if existing else 1, "", "")]
                if not existing:
                    results.append(subprocess.CompletedProcess([], 0, "", ""))
                with patch.object(bump, "git", return_value=subprocess.CompletedProcess(
                    [], 0, "a" * 40, "",
                )), patch.object(bump, "run", side_effect=results) as run:
                    bump.publish(cwd, "0.3.1")
                    self.assertEqual(run.call_count, 1 if existing else 2)
                    if not existing:
                        self.assertIn("--verify-tag", run.call_args.args)

    def test_release_creation_failure_propagates(self):
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            (cwd / "CHANGELOG.md").write_text("## v0.3.1\n\n- Fix it\n")
            with patch.object(bump, "git", return_value=subprocess.CompletedProcess(
                [], 0, "a" * 40, "",
            )), patch.object(bump, "run", side_effect=[
                subprocess.CompletedProcess([], 1, "", ""),
                subprocess.CalledProcessError(1, "gh release create"),
            ]):
                with self.assertRaises(subprocess.CalledProcessError):
                    bump.publish(cwd, "0.3.1")

    def exercise(self, bump_code=0, push_codes=(0,), head="fix: something"):
        pushes = iter(push_codes)
        clones = []

        def git(*args, cwd, check=True):
            result = subprocess.CompletedProcess(args, 0, "", "")
            if args[0] == "clone":
                clones.append(cwd)
                (cwd / "package.json").write_text('{"version":"0.3.0"}')
            elif args[0] == "log":
                result.stdout = head
            elif args[0] == "push":
                self.assertEqual(args[1], "--atomic")
                self.assertEqual(args[-1], "refs/tags/v0.3.1:refs/tags/v0.3.1")
                self.assertNotIn("--force", args)
                result.returncode = next(pushes)
            return result

        def run(*args, cwd, check=True):
            self.assertEqual(args, ("cz", "bump", "--changelog", "--yes"))
            if bump_code == 0:
                (cwd / "package.json").write_text('{"version":"0.3.1"}')
            return subprocess.CompletedProcess(args, bump_code, "", "")

        with patch.dict("os.environ", {"GITHUB_REPOSITORY": "keycardai/gha-keycard-auth"}), \
             patch.object(bump, "git", side_effect=git), \
             patch.object(bump, "run", side_effect=run), \
             patch.object(bump, "publish") as publish:
            bump.main()
            return clones, publish.call_args_list

    def test_success(self):
        clones, published = self.exercise()
        self.assertEqual(len(clones), 1)
        self.assertEqual(published[0].args[1], "0.3.1")

    def test_no_release(self):
        for code in (3, 21):
            with self.subTest(code=code):
                _, published = self.exercise(bump_code=code)
                self.assertEqual(published, [])

    def test_bump_failure_is_not_swallowed(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.exercise(bump_code=1)

    def test_push_race_retries_in_fresh_clone(self):
        clones, published = self.exercise(push_codes=(1, 0))
        self.assertEqual(len(set(clones)), 2)
        self.assertEqual(len(published), 1)

    def test_push_failure_is_bounded(self):
        with self.assertRaises(RuntimeError):
            self.exercise(push_codes=(1, 1, 1))

    def test_retry_recovers_release_after_bump_was_pushed(self):
        _, published = self.exercise(head="bump: 0.2.0 → 0.3.0")
        self.assertEqual(published[0].args[1], "0.3.0")


if __name__ == "__main__":
    unittest.main()
