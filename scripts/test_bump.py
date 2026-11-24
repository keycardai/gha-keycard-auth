import importlib.util
import os
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
            bump.clean_git("push", "--atomic", "origin", "main", "refs/tags/v0.4.0", token="app-token")
            self.assertEqual(run.call_args.args[0], [
                "git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
                "-c", "credential.helper=!gh auth git-credential",
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

    def test_only_pushes_may_receive_the_token(self):
        with self.assertRaises(ValueError):
            bump.clean_git("fetch", "origin", "main", token="app-token")


class RealCommitizenTests(unittest.TestCase):
    def fixture(self, directory):
        repo = Path(directory)
        env = {key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")}
        env.update(GIT_AUTHOR_NAME="Release fixture", GIT_AUTHOR_EMAIL="fixture@example.com",
                   GIT_COMMITTER_NAME="Release fixture", GIT_COMMITTER_EMAIL="fixture@example.com",
                   GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="commit.gpgsign", GIT_CONFIG_VALUE_0="false",
                   GIT_CONFIG_KEY_1="tag.gpgsign", GIT_CONFIG_VALUE_1="false")

        def run(*cmd, check=True):
            return subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True, check=check)

        self.assertEqual(run("cz", "version").stdout.strip(), "4.19.2")
        run("git", "init", "--initial-branch=main")
        source = Path(__file__).parent.parent
        (repo / ".cz.toml").write_text((source / ".cz.toml").read_text())
        (repo / "package.json").write_text('{"version":"0.3.0"}\n')
        (repo / "CHANGELOG.md").write_text("## v0.3.0\n\n- Existing history\n")
        run("git", "add", ".cz.toml", "package.json", "CHANGELOG.md")
        run("git", "commit", "-m", "release: fixture")
        run("git", "tag", "v0.3.0")
        return repo, run

    def commit(self, repo, run, subject):
        (repo / "fixture.txt").write_text(subject)
        run("git", "add", "fixture.txt")
        run("git", "commit", "-m", subject)

    def test_real_zero_major_increments(self):
        cases = [
            ("feat(oauth): add support", "0.4.0"), ("fix: repair support", "0.3.1"),
            ("perf!: break support", "0.4.0"), ("ci: checks\n\nBREAKING CHANGE: change support", "0.4.0"),
            *((f"{kind}: tidy", None) for kind in ("ci", "test", "build", "refactor", "perf", "revert", "chore(deps)")),
        ]
        for subject, expected in cases:
            with self.subTest(subject=subject), tempfile.TemporaryDirectory() as directory:
                repo, run = self.fixture(directory)
                self.commit(repo, run, subject)
                computed = run("cz", "bump", "--get-next", check=False)
                self.assertEqual(computed.returncode, 21 if expected is None else 0, computed.stderr)
                if expected is not None:
                    self.assertEqual(computed.stdout.strip(), expected)


class PrepareTests(unittest.TestCase):
    def test_preparation_rejects_a_token_before_running_any_command(self):
        with patch.dict(os.environ, {"GH_TOKEN": "app-token"}), patch.object(bump, "git") as git:
            with self.assertRaisesRegex(RuntimeError, "token-free job"):
                bump.prepare(Path("release.bundle"))
            git.assert_not_called()

    def test_preparation_and_clean_skip(self):
        for tag in (None, "v0.4.0"):
            def git(*args, **kwargs):
                if args[0] == "rev-parse":
                    return result("a" * 40)
                return result()
            with patch.dict(os.environ, {}, clear=True), patch.object(bump, "git", side_effect=git) as run, \
                 patch.object(bump, "run_bump", return_value=tag):
                self.assertEqual(bump.prepare(Path("release.bundle")), tag)
                commands = [call.args for call in run.call_args_list]
                self.assertIn(("merge", "--ff-only", "origin/main"), commands)
                self.assertEqual(any(args[0] == "bundle" for args in commands), tag is not None)
                self.assertFalse(any(args[0] == "push" for args in commands))

    def test_workflows_keep_app_secrets_out_of_preparation(self):
        workflows = Path(__file__).parent.parent / ".github/workflows"
        prepare = (workflows / "release-prepare.yml").read_text()
        self.assertNotIn("secrets:", prepare)
        self.assertNotIn("GH_TOKEN", prepare)
        self.assertNotIn("create-github-app-token", prepare)
        push = (workflows / "release-push.yml").read_text()
        self.assertNotIn("pip install", push)
        self.assertNotIn("cz bump", push)
        self.assertIn("scripts/bump.py push", push)


class PublishTests(unittest.TestCase):
    def exercise(self, *, rejected=False, advanced=False, major_fails=False, bad_paths=False,
                 existing=None, bad_tag=False, tag="v0.4.0"):
        self.commands = []

        def clean_git(*args, cwd=None, token=None, check=True):
            self.commands.append(args)
            self.assertEqual(token, "app-token" if args[0] == "push" else None)
            if args[0] != "clone":
                self.assertEqual(cwd.name, "repository.git")
            if args[0] == "rev-parse":
                if "--verify" in args:
                    return result(existing or "", code=0 if existing else 128)
                return result({
                    "refs/prepared/main^{commit}": "new",
                    "refs/prepared/tag^{commit}": "bad" if bad_tag else "new",
                    "refs/heads/main": "advanced" if advanced else "old",
                    "refs/prepared/main^": "old",
                }[args[1]])
            if args[0] == "show":
                return result('[tool.commitizen]\nversion="' + tag[1:] + '"')
            if args[0] == "log":
                return result("bump: release")
            if args[0] == "diff":
                return result("scripts/evil.py" if bad_paths else ".cz.toml\npackage.json\nCHANGELOG.md\n")
            if args[:2] == ("push", "--atomic"):
                return result(code=1 if rejected else 0)
            if args[:2] == ("push", "origin") and major_fails:
                raise subprocess.CalledProcessError(1, args)
            return result()

        with patch.object(bump, "clean_git", side_effect=clean_git), patch.object(bump, "run_bump") as cz:
            status = bump.publish(Path("release.bundle"), tag, "trusted-remote", "app-token")
            cz.assert_not_called()
            return status

    def test_fresh_clone_atomic_push_and_only_major_tag_forced(self):
        for tag, major in (("v0.4.0", "v0"), ("v1.2.3", "v1")):
            self.assertEqual(self.exercise(tag=tag), 0)
            self.assertEqual(self.commands[0][:5], ("clone", "--bare", "--no-local", "--template=", "trusted-remote"))
            self.assertEqual([args for args in self.commands if args[0] == "push"], [
                ("push", "--atomic", "origin", "main", f"refs/tags/{tag}"),
                ("push", "origin", f"+refs/tags/{major}:refs/tags/{major}"),
            ])

    def test_rejection_or_advanced_main_requests_fresh_preparation(self):
        self.assertEqual(self.exercise(rejected=True), 75)
        self.assertFalse(any(args[:2] == ("push", "origin") for args in self.commands))
        self.assertEqual(self.exercise(advanced=True), 75)
        self.assertFalse(any(args[0] == "push" for args in self.commands))

    def test_major_push_failure_fails_the_job(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.exercise(major_fails=True)

    def test_prepared_checkout_cannot_supply_executable_files_or_move_semver(self):
        for kwargs in ({"bad_paths": True}, {"existing": "other"}, {"bad_tag": True}):
            with self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError):
                self.exercise(**kwargs)
            self.assertFalse(any(args[0] == "push" for args in self.commands))

    def test_invalid_tag_is_rejected(self):
        with self.assertRaises(ValueError):
            self.exercise(tag="../main")


if __name__ == "__main__":
    unittest.main()
