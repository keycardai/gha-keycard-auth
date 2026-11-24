import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tomllib
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("bump", Path(__file__).with_name("bump.py"))
bump = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bump)


def result(stdout="", code=0):
    return subprocess.CompletedProcess([], code, stdout, "")


class CommandTests(unittest.TestCase):
    def test_commands_strip_tokens_from_the_environment(self):
        with patch.dict(os.environ, {"GH_TOKEN": "app-token", "GITHUB_TOKEN": "other-token"}), \
             patch.object(bump.subprocess, "run", return_value=result()) as run:
            for cmd in (["cz", "bump"], ["git", "fetch", "origin", "main"]):
                bump.run_command(cmd)
                env = run.call_args.kwargs["env"]
                self.assertNotIn("GH_TOKEN", env)
                self.assertNotIn("GITHUB_TOKEN", env)

    def test_push_gets_the_token_and_credential_helper(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "other-token"}), \
             patch.object(bump.subprocess, "run", return_value=result()) as run:
            bump.git("push", "--atomic", "origin", "main", "refs/tags/v0.4.0", token="app-token")
            self.assertEqual(run.call_args.args[0], [
                "git", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
                "push", "--atomic", "origin", "main", "refs/tags/v0.4.0",
            ])
            self.assertEqual(run.call_args.kwargs["env"]["GH_TOKEN"], "app-token")
            self.assertNotIn("GITHUB_TOKEN", run.call_args.kwargs["env"])

    def test_command_errors_propagate_unless_requested(self):
        with patch.object(bump.subprocess, "run", return_value=result(code=1)):
            with self.assertRaises(subprocess.CalledProcessError):
                bump.run_command(["git", "fetch"])
            self.assertEqual(bump.run_command(["git", "fetch"], check=False).returncode, 1)


class BumpTests(unittest.TestCase):
    def test_bump_and_clean_skips(self):
        for codes, deps, expected in [
            ([0], False, "v0.4.0"),
            ([3], False, None),
            ([21], False, None),
            ([21, 0], True, "v0.4.0"),
        ]:
            with self.subTest(codes=codes), \
                 patch.object(bump, "run_command", side_effect=[result(code=code) for code in codes]) as run, \
                 patch.object(bump, "dependency_dist_changed", return_value=deps) as detect, \
                 patch.object(bump, "current_tag", return_value="v0.4.0"):
                self.assertEqual(bump.run_bump(), expected)
                self.assertEqual(run.call_args_list[0].args, (["cz", "bump", "--changelog", "--yes"],))
                if len(codes) == 2:
                    self.assertEqual(run.call_args.args[0][-2:], ["--increment", "PATCH"])
                if codes == [0]:
                    detect.assert_not_called()
                self.assertTrue(all("token" not in call.kwargs for call in run.call_args_list))

    def test_bump_errors_propagate(self):
        for codes in ([1], [21, 1], [21, 21]):
            with self.subTest(codes=codes), \
                 patch.object(bump, "run_command", side_effect=[result(code=code) for code in codes]), \
                 patch.object(bump, "dependency_dist_changed", return_value=True):
                with self.assertRaises(subprocess.CalledProcessError):
                    bump.run_bump()

    def test_dependency_dist_detection(self):
        for subject, paths, expected in [
            ("chore(deps): bump runtime", "dist/index.js\n", True),
            ("chore(deps): bump tools", "", False),
            ("chore(deps-dev): bump tools", "dist/index.js\n", False),
            ("ci: update CI", "dist/index.js\n", False),
        ]:
            with self.subTest(subject=subject):
                def git(*args, **kwargs):
                    if args[0] == "describe":
                        self.assertIn("v[0-9]*.[0-9]*.[0-9]*", args)
                        return result("v0.3.0\n")
                    if args[0] == "log":
                        self.assertEqual(args[-1], "v0.3.0..HEAD")
                        return result(f"abc\0{subject}\n")
                    self.assertEqual(args, ("diff-tree", "--root", "--no-commit-id", "--name-only",
                                            "-r", "abc", "--", "dist/"))
                    return result(paths)
                with patch.object(bump, "git", side_effect=git):
                    self.assertEqual(bump.dependency_dist_changed(), expected)

    def test_empty_history_and_no_tags(self):
        for described in (result("v0.3.0\n"), result(code=128)):
            with patch.object(bump, "git", side_effect=[described, result()]) as git:
                self.assertFalse(bump.dependency_dist_changed())
                self.assertEqual(git.call_args.args[-1], "HEAD" if described.returncode else "v0.3.0..HEAD")

    def test_dependency_diff_errors_propagate(self):
        with patch.object(bump, "git", side_effect=[
            result("v0.3.0\n"), result("abc\0chore(deps): update\n"),
            subprocess.CalledProcessError(1, "git diff-tree"),
        ]):
            with self.assertRaises(subprocess.CalledProcessError):
                bump.dependency_dist_changed()

    def test_release_patterns(self):
        config = tomllib.loads((Path(__file__).parent.parent / ".cz.toml").read_text())
        customize = config["tool"]["commitizen"]["customize"]
        pattern = customize["changelog_pattern"]
        for subject in ("chore(deps): bump runtime", "chore(deps)!: bump runtime", "feat(oauth): support v2"):
            self.assertIsNotNone(re.match(pattern, subject))
        for subject in ("chore: tidy", "chore(dev): tidy", "chore(deps-dev): bump tools"):
            self.assertIsNone(re.match(pattern, subject))
        mapping = customize["bump_map"]
        for prefix, expected in [
            ("feat", "MINOR"), ("fix", "PATCH"), ("BREAKING CHANGE", "MAJOR"), ("perf!", "MAJOR"),
            *((prefix, None) for prefix in ("ci", "test", "build", "refactor", "perf", "revert", "chore")),
        ]:
            increment = next((value for regex, value in mapping.items() if re.match(regex, prefix)), None)
            self.assertEqual(increment, expected)

    def test_major_tag_refspec_is_the_only_forced_push(self):
        for tag, major in [("v0.4.0", "v0"), ("v1.2.3", "v1")]:
            with patch.object(bump, "git") as git:
                bump.move_major_tag(tag, "app-token")
                self.assertEqual(git.call_args_list[0].args, ("tag", "--force", major, f"{tag}^{{commit}}"))
                self.assertEqual(git.call_args.args, ("push", "origin", f"+refs/tags/{major}:refs/tags/{major}"))
                self.assertEqual(git.call_args.kwargs, {"token": "app-token"})


class ReleaseTests(unittest.TestCase):
    def exercise(self, push_codes=(0,), tags=("v0.4.0",), heads=("feat: support v2",), dirty=False,
                 major_fails=False, command_fails=None, remote_tag=False, mismatched=False):
        pushes = iter(push_codes)
        head_iter = iter(heads)
        tag_iter = iter(tags)
        self.commands = []

        def git(*args, token=None, check=True):
            self.commands.append(args)
            if args[0] == "push":
                self.assertEqual(token, "app-token")
            else:
                self.assertIsNone(token)
            if args[0] == command_fails:
                raise subprocess.CalledProcessError(1, args)
            if args[0] == "status":
                return result(" M README.md\n" if dirty else "")
            if args[0] == "log":
                return result(next(head_iter))
            if args[:2] == ("push", "--atomic"):
                self.assertFalse(check)
                return result(code=next(pushes))
            if args[:2] == ("push", "origin") and major_fails:
                raise subprocess.CalledProcessError(1, args)
            if args[0] == "ls-remote":
                return result("a" * 40 + "\trefs/tags/v0.4.0\n" if remote_tag else "")
            if args[0] == "rev-parse":
                return result("b" * 40 if mismatched and args[1] == "HEAD" else "a" * 40)
            return result()

        def run_bump():
            self.commands.append(("cz-bump",))
            return next(tag_iter)

        with patch.object(bump, "git", side_effect=git), \
             patch.object(bump, "run_bump", side_effect=run_bump) as run, \
             patch.object(bump, "current_tag", return_value="v0.4.0"):
            bump.release("app-token")
            return run.call_count

    def test_release_pushes_main_and_tag_atomically_then_moves_major(self):
        self.assertEqual(self.exercise(), 1)
        pushes = [args for args in self.commands if args[0] == "push"]
        self.assertEqual(pushes, [
            ("push", "--atomic", "origin", "main", "refs/tags/v0.4.0"),
            ("push", "origin", "+refs/tags/v0:refs/tags/v0"),
        ])

    def test_no_increment_skips_all_pushes(self):
        self.exercise(tags=(None,))
        self.assertFalse(any(args[0] == "push" for args in self.commands))

    def test_rejected_push_resets_deletes_tag_and_rebumps(self):
        count = self.exercise(push_codes=(1, 0), tags=("v0.4.0", "v0.5.0"), heads=("feat: one", "feat: two"))
        self.assertEqual(count, 2)
        reset = self.commands.index(("reset", "--hard", "origin/main"))
        deleted = self.commands.index(("tag", "--delete", "v0.4.0"))
        second_bump = self.commands.index(("cz-bump",), self.commands.index(("cz-bump",)) + 1)
        self.assertLess(reset, deleted)
        self.assertLess(deleted, second_bump)
        self.assertIn(("push", "--atomic", "origin", "main", "refs/tags/v0.5.0"), self.commands)
        self.assertFalse(any("pull" in args or "--tags" in args and args[0] == "push" for args in self.commands))

    def test_repeated_rejections_fail_the_job(self):
        with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
            self.exercise(push_codes=(1, 1, 1), tags=("v0.4.0",) * 3, heads=("fix: update",) * 3)
        self.assertEqual(self.commands.count(("reset", "--hard", "origin/main")), 2)

    def test_major_push_failure_fails_without_repeating_the_release(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.exercise(major_fails=True)
        self.assertEqual(self.commands.count(("cz-bump",)), 1)

    def test_rerun_repairs_major_without_bumping_or_retagging_semver(self):
        self.assertEqual(self.exercise(heads=("bump: gha-keycard-auth 0.3.0 → 0.4.0",)), 0)
        self.assertNotIn(("cz-bump",), self.commands)
        self.assertEqual([args for args in self.commands if args[0] == "push"], [
            ("push", "origin", "+refs/tags/v0:refs/tags/v0"),
        ])

    def test_retry_recovers_a_push_that_reached_the_server(self):
        count = self.exercise(push_codes=(1,), heads=("feat: update", "bump: 0.3.0 → 0.4.0"), remote_tag=True)
        self.assertEqual(count, 1)
        self.assertIn(("fetch", "origin", "refs/tags/v0.4.0:refs/tags/v0.4.0"), self.commands)

    def test_dirty_checkout_is_never_reset(self):
        with self.assertRaisesRegex(RuntimeError, "clean checkout"):
            self.exercise(dirty=True)
        self.assertEqual(self.commands, [("status", "--porcelain")])

    def test_git_errors_stop_the_release(self):
        for command in ("fetch", "switch", "merge", "reset"):
            with self.subTest(command=command), self.assertRaises(subprocess.CalledProcessError):
                self.exercise(push_codes=(1,), command_fails=command)

    def test_existing_semver_tag_cannot_be_moved(self):
        with self.assertRaisesRegex(RuntimeError, "does not point to the bump commit"):
            self.exercise(heads=("bump: 0.3.0 → 0.4.0",), mismatched=True)
        self.assertFalse(any(args[0] == "push" for args in self.commands))


if __name__ == "__main__":
    unittest.main()
