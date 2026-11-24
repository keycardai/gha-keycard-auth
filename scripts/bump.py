#!/usr/bin/env python3
"""Open a version bump PR or publish the merged bump."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from string import Template
import tempfile
import tomllib


def run(*args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True)
    print(result.stdout, end="", flush=True)
    print(result.stderr, end="", flush=True)
    if check:
        result.check_returncode()
    return result


def git(*args: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    return run(
        "git", "-c", "credential.helper=", "-c",
        "credential.helper=!gh auth git-credential", *args, cwd=cwd, check=check,
    )


def release_notes(changelog: str, version: str, sha: str) -> str:
    heading = re.search(rf"^## \[?v?{re.escape(version)}\]?(?: .*)?$", changelog, re.M)
    if heading is None:
        raise ValueError(f"No changelog entry for {version}")
    remainder = changelog[heading.end():]
    next_heading = re.search(r"^## ", remainder, re.M)
    body = changelog[heading.start():heading.end()]
    body += remainder[:next_heading.start()] if next_heading else remainder
    return (
        f"{body.strip()}\n\nCommit: {sha}\n\n"
        f"```yaml\nuses: keycardai/gha-keycard-auth@{sha} # v{version}\n```\n"
    )


def publish(cwd: Path, version: str) -> None:
    tag = f"v{version}"
    sha = git("rev-parse", f"{tag}^{{commit}}", cwd=cwd).stdout.strip()
    existing = run("gh", "release", "view", tag, cwd=cwd, check=False)
    if existing.returncode == 0:
        print(f"Release {tag} already exists. Leaving it unchanged.")
        return
    changelog = git("show", f"{tag}:CHANGELOG.md", cwd=cwd).stdout
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md") as notes:
        notes.write(release_notes(changelog, version, sha))
        notes.flush()
        run("gh", "release", "create", tag, "--verify-tag", "--title", tag,
            "--notes-file", notes.name, cwd=cwd)


def ensure_latest_release(cwd: Path) -> None:
    tags = git("tag", "--list", "v*", "--sort=-version:refname", cwd=cwd).stdout.splitlines()
    if tags:
        publish(cwd, tags[0][1:])


def dependency_dist_changed(cwd: Path) -> bool:
    latest = git("describe", "--tags", "--abbrev=0", cwd=cwd, check=False)
    revision = f"{latest.stdout.strip()}..HEAD" if latest.returncode == 0 else "HEAD"
    commits = git("log", "--format=%H%x00%s", revision, cwd=cwd).stdout.splitlines()
    for commit in commits:
        sha, subject = commit.split("\0", 1)
        if re.match(r"^chore\(deps\)!?:", subject):
            paths = git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r",
                        sha, "--", "dist/", cwd=cwd).stdout
            if paths.strip():
                return True
    return False


def bump_files(cwd: Path, increment: str) -> bool:
    args = ["cz", "bump", "--changelog", "--yes", "--version-files-only"]
    if increment != "auto":
        args.extend(["--increment", increment.upper()])
    result = run(*args, cwd=cwd, check=False)
    if result.returncode in (3, 21):
        if increment != "auto" or not dependency_dist_changed(cwd):
            print("No release-worthy commits. Skipping bump.")
            return False
        result = run(*args, "--increment", "PATCH", cwd=cwd, check=False)
    result.check_returncode()
    return True


def create_bump_pr(increment: str) -> None:
    repository = os.environ["GITHUB_REPOSITORY"]
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    with tempfile.TemporaryDirectory(prefix="keycard-bump-") as directory:
        cwd = Path(directory)
        git("clone", "--branch", "main", f"{server}/{repository}.git", ".", cwd=cwd)
        old_version = json.loads((cwd / "package.json").read_text())["version"]
        head = git("log", "-1", "--format=%s", cwd=cwd).stdout.strip()
        if head.startswith("bump:"):
            print("The current version is already bumped. Publish it before another bump.")
            return
        if not bump_files(cwd, increment):
            return
        version = json.loads((cwd / "package.json").read_text())["version"]
        branch = f"release/v{version}"
        config = tomllib.loads((cwd / ".cz.toml").read_text())["tool"]["commitizen"]
        message = Template(config["bump_message"]).substitute(
            current_version=old_version, new_version=version,
        )
        existing = run("gh", "pr", "list", "--head", branch, "--base", "main",
                       "--state", "open", "--json", "url", "--jq", ".[0].url // empty", cwd=cwd)
        if existing.stdout.strip():
            print(f"Bump PR already exists: {existing.stdout.strip()}")
            return
        git("config", "user.name", "github-actions[bot]", cwd=cwd)
        git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com", cwd=cwd)
        git("switch", "--create", branch, cwd=cwd)
        git("add", "package.json", "package-lock.json", "CHANGELOG.md", cwd=cwd)
        git("commit", "-m", message, cwd=cwd)
        git("push", "origin", f"HEAD:refs/heads/{branch}", cwd=cwd)
        run("gh", "pr", "create", "--head", branch, "--base", "main", "--title", message,
            "--body", f"Update package versions and generate the changelog from commits.\n\n"
            f"Merge with this PR title to publish v{version}.", cwd=cwd)


def publish_bump(cwd: Path) -> None:
    head = git("log", "-1", "--format=%s", cwd=cwd).stdout.strip()
    if not head.startswith("bump:"):
        ensure_latest_release(cwd)
        return
    version = json.loads((cwd / "package.json").read_text())["version"]
    tag = f"v{version}"
    sha = git("rev-parse", "HEAD", cwd=cwd).stdout.strip()
    existing = git("rev-parse", "--verify", "--quiet", f"refs/tags/{tag}", cwd=cwd, check=False)
    if existing.returncode == 0:
        tagged_sha = git("rev-parse", f"{tag}^{{commit}}", cwd=cwd).stdout.strip()
        if tagged_sha != sha:
            raise ValueError(f"Refusing to move immutable tag {tag}")
    ensure_latest_release(cwd)
    if existing.returncode != 0:
        git("tag", tag, sha, cwd=cwd)
        git("push", "origin", f"refs/tags/{tag}:refs/tags/{tag}", cwd=cwd)
    publish(cwd, version)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--increment", choices=("auto", "major", "minor", "patch"), default="auto")
    parser.add_argument("--publish", action="store_true", help="Tag and release the checked-out bump")
    args = parser.parse_args()
    if args.publish:
        publish_bump(Path.cwd())
    else:
        create_bump_pr(args.increment)


if __name__ == "__main__":
    main()
