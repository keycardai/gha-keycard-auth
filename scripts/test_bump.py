import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
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
            bump.git("push", "--atomic", "origin", "main", "refs/tags/v0.4.0", token="app-token")
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
            bump.git("fetch", "origin", "main", token="app-token")


class RealCommitizenTests(unittest.TestCase):
    def fixture(self, directory, history=None):
        repo = Path(directory)
        env = {key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")}
        env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env["PATH"]
        env.update(GIT_AUTHOR_NAME="Release fixture", GIT_AUTHOR_EMAIL="fixture@example.com",
                   GIT_COMMITTER_NAME="Release fixture", GIT_COMMITTER_EMAIL="fixture@example.com",
                   GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="commit.gpgsign", GIT_CONFIG_VALUE_0="false",
                   GIT_CONFIG_KEY_1="tag.gpgsign", GIT_CONFIG_VALUE_1="false")

        def run(*cmd, check=True):
            return subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True, check=check)

        source = Path(__file__).parent.parent
        locked = (source / "scripts/requirements-release.in").read_text().strip().removeprefix("commitizen==")
        self.assertEqual(run("cz", "version").stdout.strip(), locked)
        run("git", "init", "--initial-branch=main")
        config = re.sub(r'(?m)^version = "[^"]+"$', 'version = "0.3.0"', (source / ".cz.toml").read_text())
        (repo / ".cz.toml").write_text(config)
        (repo / "package.json").write_text('{"version":"0.3.0"}\n')
        (repo / "CHANGELOG.md").write_text(history or "## v0.3.0\n\n- Existing history\n")
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

    def test_real_changelog_preserves_history_without_duplication(self):
        source = (Path(__file__).parent.parent / "CHANGELOG.md").read_text()
        start = re.search(r"(?m)^## (?:v0\.3\.0|\[0\.3\.0\]).*$", source).start()
        history = source[start:]
        baseline = "# Changelog\n\n" + history
        with tempfile.TemporaryDirectory() as directory:
            repo, run = self.fixture(directory, baseline)
            self.commit(repo, run, "feat: first release")
            dry = run("cz", "bump", "--changelog", "--dry-run")
            self.assertEqual((repo / "CHANGELOG.md").read_text(), baseline)
            self.assertNotIn("## v0.3.0", dry.stdout)
            run("cz", "bump", "--changelog", "--yes")
            self.assertEqual((repo / "CHANGELOG.md").read_text().count(history), 1)
            self.commit(repo, run, "feat: next release")
            following = run("cz", "bump", "--changelog", "--dry-run")
            self.assertNotIn("## v0.4.0", following.stdout)
            run("cz", "bump", "--changelog", "--yes")
            stored = (repo / "CHANGELOG.md").read_text()
            self.assertEqual(stored.count(history), 1)
            self.assertEqual(stored.count("Provider abstraction (`src/providers/`)"), 1)
            for version in ("0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"):
                self.assertEqual(len(re.findall(r"(?m)^## v" + re.escape(version) + r"(?:\s|$)", stored)), 1)


class ReleaseTests(unittest.TestCase):
    def exercise(self, *, push_codes=(0,), tag="v0.4.0", head="feat: release", dirty=False,
                 major_fails=False, bad_tag=False, remote_tag=False):
        self.commands = []
        codes = iter(push_codes)

        def git(*args, token=None, check=True):
            self.commands.append(args)
            self.assertEqual(token, "app-token" if args[0] == "push" else None)
            if args[0] == "status":
                return result(" M package.json" if dirty else "")
            if args[0] == "log":
                return result(head)
            if args[0] == "rev-parse":
                return result("bad" if bad_tag and args[1] != "HEAD" else "new")
            if args[0] == "ls-remote":
                return result("remote-tag" if remote_tag else "")
            if args[:2] == ("push", "--atomic"):
                self.assertFalse(check)
                return result(code=next(codes))
            if args[:2] == ("push", "origin") and major_fails:
                raise subprocess.CalledProcessError(1, args)
            return result()

        with patch.object(bump, "git", side_effect=git), \
             patch.object(bump, "run_bump", return_value=tag) as cz, \
             patch.object(bump, "current_tag", return_value=tag):
            self.cz = cz
            bump.release("app-token")

    def test_atomic_push_and_only_major_tag_forced(self):
        for tag, major in (("v0.4.0", "v0"), ("v1.2.3", "v1")):
            self.exercise(tag=tag)
            self.assertEqual([args for args in self.commands if args[0] == "push"], [
                ("push", "--atomic", "origin", "main", f"refs/tags/{tag}"),
                ("push", "origin", f"+refs/tags/{major}:refs/tags/{major}"),
            ])

    def test_clean_skip_does_not_push(self):
        self.exercise(tag=None)
        self.cz.assert_called_once_with()
        self.assertFalse(any(args[0] == "push" for args in self.commands))

    def test_rejection_rebuilds_from_latest_main(self):
        self.exercise(push_codes=(1, 0))
        self.assertEqual(self.cz.call_count, 2)
        rejected = self.commands.index(("push", "--atomic", "origin", "main", "refs/tags/v0.4.0"))
        self.assertEqual(self.commands[rejected + 1:rejected + 5], [
            ("fetch", "origin", "main"), ("reset", "--hard", "origin/main"),
            ("tag", "--delete", "v0.4.0"), ("ls-remote", "--tags", "origin", "refs/tags/v0.4.0"),
        ])
        self.assertFalse(any(args[0] == "pull" for args in self.commands))

    def test_retry_restores_a_tag_published_by_another_run(self):
        self.exercise(push_codes=(1, 0), remote_tag=True)
        self.assertIn(("fetch", "origin", "refs/tags/v0.4.0:refs/tags/v0.4.0"), self.commands)

    def test_all_rejected_pushes_fail_the_job(self):
        with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
            self.exercise(push_codes=(1, 1, 1))
        self.assertEqual(self.cz.call_count, 3)
        self.assertEqual(self.commands.count(("reset", "--hard", "origin/main")), 2)
        self.assertFalse(any(args[:2] == ("push", "origin") for args in self.commands))

    def test_major_push_failure_fails_the_job(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.exercise(major_fails=True)

    def test_existing_bump_repairs_only_the_major_tag(self):
        self.exercise(head="bump: release")
        self.cz.assert_not_called()
        self.assertEqual([args for args in self.commands if args[0] == "push"], [
            ("push", "origin", "+refs/tags/v0:refs/tags/v0"),
        ])

    def test_recovery_refuses_a_mismatched_semver_tag(self):
        with self.assertRaisesRegex(RuntimeError, "does not point to the bump commit"):
            self.exercise(head="bump: release", bad_tag=True)
        self.assertFalse(any(args[0] == "push" for args in self.commands))

    def test_dirty_checkout_fails_before_bumping(self):
        with self.assertRaisesRegex(RuntimeError, "clean checkout"):
            self.exercise(dirty=True)
        self.cz.assert_not_called()

    def test_workflows_share_the_hash_locked_dependencies(self):
        workflows = Path(__file__).parent.parent / ".github/workflows"
        for workflow in ("main.yml", "ci.yml"):
            self.assertIn("--require-hashes --no-deps -r scripts/requirements-release.txt",
                          (workflows / workflow).read_text())
        self.assertIn("persist-credentials: false", (workflows / "main.yml").read_text())


if __name__ == "__main__":
    unittest.main()
