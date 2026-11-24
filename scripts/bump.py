#!/usr/bin/env python3
"""Publish an atomic version bump, retrying against fresh main after push races."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


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


def main() -> None:
    repository = os.environ["GITHUB_REPOSITORY"]
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    for attempt in range(1, 4):
        with tempfile.TemporaryDirectory(prefix="keycard-release-") as directory:
            cwd = Path(directory)
            git("clone", "--branch", "main", f"{server}/{repository}.git", ".", cwd=cwd)
            git("config", "user.name", "github-actions[bot]", cwd=cwd)
            git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com", cwd=cwd)
            ensure_latest_release(cwd)
            head = git("log", "-1", "--format=%s", cwd=cwd).stdout.strip()
            if head.startswith("bump:"):
                return
            bump = run("cz", "bump", "--changelog", "--yes", cwd=cwd, check=False)
            if bump.returncode in (3, 21):
                if not dependency_dist_changed(cwd):
                    print("No release-worthy commits. Skipping release.")
                    return
                bump = run("cz", "bump", "--changelog", "--yes", "--increment", "PATCH",
                           cwd=cwd, check=False)
            bump.check_returncode()
            version = json.loads((cwd / "package.json").read_text())["version"]
            tag = f"v{version}"
            pushed = git("push", "--atomic", "origin", "HEAD:refs/heads/main",
                         f"refs/tags/{tag}:refs/tags/{tag}", cwd=cwd, check=False)
            if pushed.returncode == 0:
                publish(cwd, version)
                return
            print(f"Push failed on attempt {attempt}/3. Retrying from fresh main.")
    raise RuntimeError("Could not push release after three attempts")


if __name__ == "__main__":
    main()
