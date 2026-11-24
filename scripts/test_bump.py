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
                with patch.object(bump, "git", side_effect=[
                    subprocess.CompletedProcess([], 0, "a" * 40, ""),
                    subprocess.CompletedProcess([], 0, "## v0.3.1\n\n- Fix it\n", ""),
                ]), patch.object(bump, "run", side_effect=results) as run:
                    bump.publish(cwd, "0.3.1")
                    self.assertEqual(run.call_count, 1 if existing else 2)
                    if not existing:
                        self.assertIn("--verify-tag", run.call_args.args)

    def test_release_creation_failure_propagates(self):
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            (cwd / "CHANGELOG.md").write_text("## v0.3.1\n\n- Fix it\n")
            with patch.object(bump, "git", side_effect=[
                subprocess.CompletedProcess([], 0, "a" * 40, ""),
                subprocess.CompletedProcess([], 0, "## v0.3.1\n\n- Fix it\n", ""),
            ]), patch.object(bump, "run", side_effect=[
                subprocess.CompletedProcess([], 1, "", ""),
                subprocess.CalledProcessError(1, "gh release create"),
            ]):
                with self.assertRaises(subprocess.CalledProcessError):
                    bump.publish(cwd, "0.3.1")

    def exercise(self, bump_code=0, push_codes=(0,), head="fix: something", tags="", deps=False):
        pushes = iter(push_codes)
        clones = []

        def git(*args, cwd, check=True):
            result = subprocess.CompletedProcess(args, 0, "", "")
            if args[0] == "clone":
                clones.append(cwd)
                (cwd / "package.json").write_text('{"version":"0.3.0"}')
            elif args[0] == "log":
                result.stdout = head
            elif args[0] == "tag":
                self.assertEqual(args, ("tag", "--list", "v*", "--sort=-version:refname"))
                result.stdout = tags
            elif args[0] == "push":
                self.assertEqual(args[1], "--atomic")
                self.assertEqual(args[-1], "refs/tags/v0.3.1:refs/tags/v0.3.1")
                self.assertNotIn("--force", args)
                result.returncode = next(pushes)
            return result

        def run(*args, cwd, check=True):
            forced = args[-2:] == ("--increment", "PATCH")
            self.assertEqual(args, ("cz", "bump", "--changelog", "--yes") +
                             (("--increment", "PATCH") if forced else ()))
            if tags:
                publish.assert_called_with(cwd, tags.splitlines()[0][1:])
            if bump_code == 0 or forced:
                (cwd / "package.json").write_text('{"version":"0.3.1"}')
            return subprocess.CompletedProcess(args, 0 if forced else bump_code, "", "")

        with patch.dict("os.environ", {"GITHUB_REPOSITORY": "keycardai/gha-keycard-auth"}), \
             patch.object(bump, "git", side_effect=git), \
             patch.object(bump, "run", side_effect=run), \
             patch.object(bump, "dependency_dist_changed", return_value=deps), \
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

    def test_dependency_dist_change_forces_patch_when_cz_finds_no_release(self):
        _, published = self.exercise(bump_code=21, deps=True)
        self.assertEqual(published[0].args[1], "0.3.1")

    def test_dependency_dist_detection(self):
        for commits, paths, expected in [
            ("", "", False),
            ("abc\0chore(deps): bump packages\n", "dist/index.js\n", True),
            ("abc\0chore(deps): bump dev tools\n", "", False),
            ("abc\0docs: update docs\n", "dist/index.js\n", False),
            ("abc\0chore(deps-dev): bump tools\n", "dist/index.js\n", False),
        ]:
            with self.subTest(commits=commits):
                def git(*args, cwd, check=True):
                    output = {"describe": "v0.3.0\n", "log": commits, "diff-tree": paths}[args[0]]
                    if args[0] == "log":
                        self.assertEqual(args[-1], "v0.3.0..HEAD")
                    if args[0] == "diff-tree":
                        self.assertEqual(args[-2:], ("--", "dist/"))
                    return subprocess.CompletedProcess(args, 0, output, "")
                with patch.object(bump, "git", side_effect=git):
                    self.assertEqual(bump.dependency_dist_changed(Path(".")), expected)

    def test_dependency_detection_without_tags(self):
        with patch.object(bump, "git", side_effect=[
            subprocess.CompletedProcess([], 128, "", "no tags"),
            subprocess.CompletedProcess([], 0, "", ""),
        ]) as git:
            self.assertFalse(bump.dependency_dist_changed(Path(".")))
            self.assertEqual(git.call_args.args[-1], "HEAD")

    def test_dependency_diff_failure_is_not_swallowed(self):
        with patch.object(bump, "git", side_effect=[
            subprocess.CompletedProcess([], 0, "v0.3.0\n", ""),
            subprocess.CompletedProcess([], 0, "abc\0chore(deps): update\n", ""),
            subprocess.CalledProcessError(1, "git diff-tree"),
        ]):
            with self.assertRaises(subprocess.CalledProcessError):
                bump.dependency_dist_changed(Path("."))

    def test_push_race_retries_in_fresh_clone(self):
        clones, published = self.exercise(push_codes=(1, 0))
        self.assertEqual(len(set(clones)), 2)
        self.assertEqual(len(published), 1)

    def test_push_failure_is_bounded(self):
        with self.assertRaises(RuntimeError):
            self.exercise(push_codes=(1, 1, 1))

    def test_retry_recovers_release_after_bump_was_pushed(self):
        _, published = self.exercise(head="bump: 0.2.0 → 0.3.0", tags="v0.3.0\n")
        self.assertEqual(published[0].args[1], "0.3.0")

    def test_recovers_latest_release_before_skipping_non_release_commits(self):
        _, published = self.exercise(
            bump_code=21, head="docs: update usage", tags="v0.10.0\nv0.9.0\n",
        )
        self.assertEqual([call.args[1] for call in published], ["0.10.0"])

    def test_recovers_latest_release_before_new_bump(self):
        _, published = self.exercise(tags="v0.3.0\nv0.2.0\n")
        self.assertEqual([call.args[1] for call in published], ["0.3.0", "0.3.1"])


if __name__ == "__main__":
    unittest.main()
