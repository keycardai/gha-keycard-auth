import importlib.util
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib
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

    def test_bump_files(self):
        for increment, codes, deps, expected in [
            ("auto", [0], False, True),
            ("auto", [3], False, False),
            ("auto", [21], False, False),
            ("auto", [21, 0], True, True),
            ("minor", [0], False, True),
            ("patch", [21], True, False),
        ]:
            with self.subTest(increment=increment, codes=codes):
                with patch.object(bump, "run", side_effect=[
                    subprocess.CompletedProcess([], code, "", "") for code in codes
                ]) as run, patch.object(bump, "dependency_dist_changed", return_value=deps):
                    self.assertEqual(bump.bump_files(Path("."), increment), expected)
                    args = ("cz", "bump", "--changelog", "--yes", "--version-files-only")
                    extra = ("--increment", increment.upper()) if increment != "auto" else ()
                    self.assertEqual(run.call_args_list[0].args, args + extra)
                    if len(codes) == 2:
                        self.assertEqual(run.call_args.args, args + ("--increment", "PATCH"))

    def test_bump_failure_is_not_swallowed(self):
        for codes in ([1], [21, 1]):
            with self.subTest(codes=codes), patch.object(bump, "run", side_effect=[
                subprocess.CompletedProcess([], code, "", "") for code in codes
            ]), patch.object(bump, "dependency_dist_changed", return_value=True):
                with self.assertRaises(subprocess.CalledProcessError):
                    bump.bump_files(Path("."), "auto")

    def test_changelog_includes_dependency_updates_but_not_other_chores(self):
        config = tomllib.loads((Path(__file__).parent.parent / ".cz.toml").read_text())
        pattern = config["tool"]["commitizen"]["customize"]["changelog_pattern"]
        for subject in ("chore(deps): bump runtime", "chore(deps)!: bump runtime", "fix: repair"):
            self.assertIsNotNone(re.match(pattern, subject))
        for subject in ("chore: tidy", "chore(dev): tidy", "chore(deps-dev): bump tools"):
            self.assertIsNone(re.match(pattern, subject))

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

    def exercise_pr(self, existing="", changed=True, head="fix: something", failure=None):
        commands = []

        def git(*args, cwd, check=True):
            commands.append(args)
            if args[0] == "clone":
                (cwd / "package.json").write_text('{"version":"0.3.0"}')
                (cwd / ".cz.toml").write_text(
                    '[tool.commitizen]\nbump_message = "bump: gha-keycard-auth $current_version → $new_version"\n'
                )
            if args[0] == failure:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, head if args[0] == "log" else "", "")

        def files(cwd, increment):
            self.assertEqual(increment, "minor")
            (cwd / "package.json").write_text('{"version":"0.4.0"}')
            return changed

        def run(*args, cwd, check=True):
            commands.append(args)
            if args[:3] == ("gh", "pr", "create") and failure == "pr":
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, existing, "")

        with patch.dict("os.environ", {"GITHUB_REPOSITORY": "keycardai/gha-keycard-auth"}), \
             patch.object(bump, "git", side_effect=git), \
             patch.object(bump, "run", side_effect=run), \
             patch.object(bump, "bump_files", side_effect=files), \
             patch.object(bump, "publish") as publish:
            bump.create_bump_pr("minor")
            publish.assert_not_called()
        return commands

    def test_creates_bump_pr_without_pushing_main_or_tags(self):
        commands = self.exercise_pr()
        self.assertIn(("push", "origin", "HEAD:refs/heads/release/v0.4.0"), commands)
        title = "bump: gha-keycard-auth 0.3.0 → 0.4.0"
        self.assertIn(("commit", "-m", title), commands)
        pr = next(args for args in commands if args[:3] == ("gh", "pr", "create"))
        self.assertEqual(pr[pr.index("--title") + 1], title)
        self.assertFalse(any("--force" in arg or "refs/tags/" in arg for args in commands for arg in args))

    def test_reuses_existing_pr(self):
        commands = self.exercise_pr(existing="https://example.com/pull/1\n")
        self.assertFalse(any(args[0] in ("commit", "push") for args in commands))
        self.assertFalse(any(args[:3] == ("gh", "pr", "create") for args in commands))

    def test_no_pr_when_no_bump_or_head_already_bumped(self):
        for kwargs in ({"changed": False}, {"head": "bump: 0.2.0 → 0.3.0"}):
            commands = self.exercise_pr(**kwargs)
            self.assertFalse(any(args[0] in ("commit", "push", "gh") for args in commands))

    def test_pr_failures_propagate(self):
        for failure in ("push", "pr"):
            with self.subTest(failure=failure), self.assertRaises(subprocess.CalledProcessError):
                self.exercise_pr(failure=failure)

    def exercise_publish(self, existing=False, tagged_sha=None, push_fails=False):
        commands = []
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            (cwd / "package.json").write_text('{"version":"0.3.1"}')

            def git(*args, cwd, check=True):
                commands.append(args)
                output = ""
                code = 0
                if args[0] == "log":
                    output = "bump: gha-keycard-auth 0.3.0 → 0.3.1"
                if args[:2] == ("rev-parse", "HEAD"):
                    output = sha
                if args[:2] == ("rev-parse", "--verify"):
                    code = 0 if existing else 1
                if args[:2] == ("rev-parse", "v0.3.1^{commit}"):
                    output = tagged_sha or sha
                if args[0] == "push" and push_fails:
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, code, output, "")

            with patch.object(bump, "git", side_effect=git), \
                 patch.object(bump, "publish") as publish, \
                 patch.object(bump, "ensure_latest_release") as recover:
                bump.publish_bump(cwd)
                recover.assert_called_once_with(cwd)
                publish.assert_called_once_with(cwd, "0.3.1")
        return commands

    def test_tags_the_exact_merged_commit(self):
        commands = self.exercise_publish()
        self.assertIn(("tag", "v0.3.1", "a" * 40), commands)
        self.assertIn(("push", "origin", "refs/tags/v0.3.1:refs/tags/v0.3.1"), commands)

    def test_existing_tag_recovers_release_without_retagging(self):
        commands = self.exercise_publish(existing=True)
        self.assertFalse(any(args[0] in ("tag", "push") for args in commands))

    def test_tag_conflict_and_push_failure_propagate(self):
        with self.assertRaisesRegex(ValueError, "Refusing to move immutable tag"):
            self.exercise_publish(existing=True, tagged_sha="b" * 40)
        with self.assertRaises(subprocess.CalledProcessError):
            self.exercise_publish(push_fails=True)

    def test_non_bump_publish_only_recovers_latest_release(self):
        cwd = Path(".")
        with patch.object(bump, "git", return_value=subprocess.CompletedProcess([], 0, "docs: update", "")), \
             patch.object(bump, "ensure_latest_release") as recover, patch.object(bump, "publish") as publish:
            bump.publish_bump(cwd)
            recover.assert_called_once_with(cwd)
            publish.assert_not_called()

    def test_latest_release_recovery(self):
        for tags, expected in [("", []), ("v0.10.0\nv0.9.0\n", ["0.10.0"])]:
            with patch.object(bump, "git", return_value=subprocess.CompletedProcess([], 0, tags, "")), \
                 patch.object(bump, "publish") as publish:
                bump.ensure_latest_release(Path("."))
                self.assertEqual([call.args[1] for call in publish.call_args_list], expected)

    def test_cli_modes(self):
        with patch("sys.argv", ["bump.py", "--increment", "patch"]), \
             patch.object(bump, "create_bump_pr") as create:
            bump.main()
            create.assert_called_once_with("patch")
        with patch("sys.argv", ["bump.py", "--publish"]), patch.object(bump, "publish_bump") as publish:
            bump.main()
            publish.assert_called_once_with(Path.cwd())


if __name__ == "__main__":
    unittest.main()
