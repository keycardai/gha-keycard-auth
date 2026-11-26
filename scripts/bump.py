#!/usr/bin/env python3
"""Bump gha-keycard-auth and publish its version and major tags."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib


def run_command(cmd: list[str], *, token: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")}
    if token is not None:
        env["GH_TOKEN"] = token
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    print(result.stdout, end="", flush=True)
    print(result.stderr, end="", flush=True)
    if check:
        result.check_returncode()
    return result


def git(*args: str, token: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    config = ["-c", "core.hooksPath=/dev/null"]
    if token is not None:
        if args[0] != "push":
            raise ValueError("Only pushes may receive the App token")
        config += ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    return run_command(["git", *config, *args], token=token, check=check)


def current_tag() -> str:
    config = tomllib.loads(Path(".cz.toml").read_text())
    return f"v{config['tool']['commitizen']['version']}"


def update_lockfile(version: str) -> None:
    path = Path("package-lock.json")
    lockfile = json.loads(path.read_text())
    lockfile["version"] = version
    lockfile["packages"][""]["version"] = version
    path.write_text(json.dumps(lockfile, indent=2) + "\n")
    git("add", "package-lock.json")


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


def move_major_tag(tag: str, token: str) -> None:
    major = tag.split(".", 1)[0]
    git("tag", "--force", major, f"{tag}^{{commit}}")
    git("push", "origin", f"+refs/tags/{major}:refs/tags/{major}", token=token)


def release_notes(tag: str) -> str:
    changelog = Path("CHANGELOG.md").read_text()
    match = re.search(rf"(?ms)^## {re.escape(tag)}(?:\s[^\n]*)?\n(.*?)(?=^## v\d|\Z)", changelog)
    return match.group(1).strip() if match else ""


def publish_release(tag: str, token: str) -> None:
    if run_command(["gh", "release", "view", tag], token=token, check=False).returncode == 0:
        print(f"GitHub release {tag} already exists.")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".md") as notes:
        notes.write(release_notes(tag) or f"Release {tag}.")
        notes.flush()
        run_command(["gh", "release", "create", tag, "--verify-tag", "--title", tag,
                     "--notes-file", notes.name], token=token)


def release(token: str, max_attempts: int = 3) -> None:
    if git("status", "--porcelain").stdout.strip():
        raise RuntimeError("Release requires a clean checkout")
    git("config", "user.email", "action@github.com")
    git("config", "user.name", "GitHub Action")
    git("fetch", "origin", "main")
    git("switch", "main")
    git("merge", "--ff-only", "origin/main")

    for attempt in range(1, max_attempts + 1):
        head = git("log", "-1", "--format=%s").stdout.strip()
        if head.startswith("bump:"):
            tag = current_tag()
            tagged_sha = git("rev-parse", f"{tag}^{{commit}}").stdout.strip()
            sha = git("rev-parse", "HEAD").stdout.strip()
            if tagged_sha != sha:
                raise RuntimeError(f"{tag} does not point to the bump commit")
            move_major_tag(tag, token)
            publish_release(tag, token)
            return

        tag = run_bump()
        if tag is None:
            return
        pushed = git("push", "--atomic", "origin", "main", f"refs/tags/{tag}", token=token, check=False)
        if pushed.returncode == 0:
            move_major_tag(tag, token)
            publish_release(tag, token)
            return
        if attempt == max_attempts:
            raise RuntimeError(f"Could not push release after {max_attempts} attempts")

        print(f"Push rejected on attempt {attempt}/{max_attempts}. Rebuilding from origin/main.")
        git("fetch", "origin", "main")
        git("reset", "--hard", "origin/main")
        git("tag", "--delete", tag)
        remote_tag = git("ls-remote", "--tags", "origin", f"refs/tags/{tag}").stdout.strip()
        if remote_tag:
            git("fetch", "origin", f"refs/tags/{tag}:refs/tags/{tag}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update-lockfile", action="store_true")
    args = parser.parse_args()
    if args.update_lockfile:
        update_lockfile(os.environ["CZ_PRE_NEW_VERSION"])
    else:
        release(os.environ["GH_TOKEN"])


if __name__ == "__main__":
    main()
