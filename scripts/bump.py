#!/usr/bin/env python3
"""Prepare a release without credentials, or publish it from a fresh repository."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib


def run_command(cmd: list[str], *, token: str | None = None, check: bool = True,
                cwd: Path | None = None, isolated: bool = False) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")}
    if isolated:
        env = {key: value for key, value in env.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
    if token is not None:
        env["GH_TOKEN"] = token
    result = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=cwd)
    print(result.stdout, end="", flush=True)
    print(result.stderr, end="", flush=True)
    if check:
        result.check_returncode()
    return result


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return run_command(["git", *args], check=check)


def clean_git(*args: str, cwd: Path | None = None, token: str | None = None,
              check: bool = True) -> subprocess.CompletedProcess:
    config = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper="]
    if token is not None:
        if args[0] != "push":
            raise ValueError("Only pushes may receive the App token")
        config += ["-c", "credential.helper=!gh auth git-credential"]
    return run_command(["git", *config, *args], cwd=cwd, token=token, check=check, isolated=True)


def config_tag(text: str) -> str:
    version = tomllib.loads(text)["tool"]["commitizen"]["version"]
    return f"v{version}"


def current_tag() -> str:
    return config_tag(Path(".cz.toml").read_text())


def dependency_dist_changed() -> bool:
    latest = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", check=False)
    revision = f"{latest.stdout.strip()}..HEAD" if latest.returncode == 0 else "HEAD"
    for commit in git("log", "--format=%H%x00%s", revision).stdout.splitlines():
        sha, subject = commit.split("\0", 1)
        if re.match(r"^chore\(deps\)!?:", subject):
            if git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha, "--", "dist/").stdout.strip():
                return True
    return False


def run_bump() -> str | None:
    cmd = ["cz", "bump", "--changelog", "--yes"]
    result = run_command(cmd, check=False)
    if result.returncode in (3, 21):
        if not dependency_dist_changed():
            print("No release-worthy commits. Skipping bump.")
            return None
        result = run_command([*cmd, "--increment", "PATCH"], check=False)
    result.check_returncode()
    return current_tag()


def prepare(bundle: Path) -> str | None:
    if "GH_TOKEN" in os.environ or "GITHUB_TOKEN" in os.environ:
        raise RuntimeError("Preparation must run in a token-free job")
    if git("status", "--porcelain").stdout.strip():
        raise RuntimeError("Release requires a clean checkout")
    git("config", "user.email", "action@github.com")
    git("config", "user.name", "GitHub Action")
    git("fetch", "origin", "main")
    git("switch", "main")
    git("merge", "--ff-only", "origin/main")
    head = git("log", "-1", "--format=%s").stdout.strip()
    tag = current_tag() if head.startswith("bump:") else run_bump()
    if tag is None:
        return None
    sha = git("rev-parse", "HEAD").stdout.strip()
    if git("rev-parse", f"{tag}^{{commit}}").stdout.strip() != sha:
        raise RuntimeError(f"{tag} does not point to the bump commit")
    git("bundle", "create", str(bundle), "main", f"refs/tags/{tag}")
    return tag


def publish(bundle: Path, tag: str, repository: str, token: str) -> int:
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Invalid release tag")
    if bundle.is_symlink() or not bundle.is_file():
        raise ValueError("Release artifact must be a regular Git bundle file")
    with tempfile.TemporaryDirectory(prefix="release-push-") as directory:
        repo = Path(directory) / "repository.git"
        clean_git("clone", "--bare", "--no-local", "--template=", repository, str(repo))

        def trusted_git(*args, **kwargs):
            return clean_git(*args, cwd=repo, **kwargs)

        trusted_git("bundle", "verify", str(bundle))
        trusted_git("fetch", "--no-tags", str(bundle), "refs/heads/main:refs/prepared/main",
                    f"refs/tags/{tag}:refs/prepared/tag")
        sha = trusted_git("rev-parse", "refs/prepared/main^{commit}").stdout.strip()
        if trusted_git("rev-parse", "refs/prepared/tag^{commit}").stdout.strip() != sha:
            raise RuntimeError("Prepared tag does not match the release commit")
        if config_tag(trusted_git("show", "refs/prepared/main:.cz.toml").stdout) != tag:
            raise RuntimeError("Prepared version does not match the release tag")
        if not trusted_git("log", "-1", "--format=%s", "refs/prepared/main").stdout.startswith("bump:"):
            raise RuntimeError("Prepared commit is not a bump commit")
        remote_sha = trusted_git("rev-parse", "refs/heads/main").stdout.strip()
        if remote_sha != sha:
            if trusted_git("rev-parse", "refs/prepared/main^").stdout.strip() != remote_sha:
                print("Main advanced. Prepare again from the latest origin/main.")
                return 75
            paths = trusted_git("diff", "--name-only", remote_sha, sha).stdout.splitlines()
            if not set(paths) <= {".cz.toml", "package.json", "CHANGELOG.md"}:
                raise RuntimeError("Prepared commit changes files outside the release metadata")
        existing = trusted_git("rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}", check=False)
        if existing.returncode == 0 and existing.stdout.strip() != sha:
            raise RuntimeError("Semver tags cannot move")
        trusted_git("update-ref", "refs/heads/main", sha)
        if existing.returncode != 0:
            trusted_git("update-ref", f"refs/tags/{tag}", sha, "")
        pushed = trusted_git("push", "--atomic", "origin", "main", f"refs/tags/{tag}", token=token, check=False)
        if pushed.returncode != 0:
            return 75
        major = tag.split(".", 1)[0]
        trusted_git("update-ref", f"refs/tags/{major}", sha)
        trusted_git("push", "origin", f"+refs/tags/{major}:refs/tags/{major}", token=token)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("prepare", "push"))
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    if args.phase == "prepare":
        tag = prepare(args.bundle.resolve())
        if tag:
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"tag={tag}\n")
        return 0
    return publish(args.bundle.resolve(), os.environ["RELEASE_TAG"], os.environ["RELEASE_REPOSITORY"],
                   os.environ["GH_TOKEN"])


if __name__ == "__main__":
    raise SystemExit(main())
