#!/usr/bin/env python3
"""Coordinate one pending fork release across scheduled T3 worktrees."""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, timeout=120).stdout.strip()


@contextmanager
def coordination_lock(directory):
    directory.mkdir(exist_ok=True)
    with (directory / "mutex").open("a") as mutex:
        fcntl.flock(mutex, fcntl.LOCK_EX)
        yield


def stable_version(tag):
    match = re.fullmatch(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag)
    return tuple(map(int, match.groups())) if match else None


def needs_release(release, contained_tags):
    version = stable_version(release["tag_name"])
    if release["draft"] or release["prerelease"] or version is None:
        raise ValueError("Upstream latest must be a published stable vX.Y.Z release")
    contained = [v for tag in contained_tags if (v := stable_version(tag)) is not None]
    return not contained or version > max(contained)


def write_json(path, value):
    descriptor, staging = tempfile.mkstemp(dir=path.parent, prefix=".state-")
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output, indent=2)
            output.write("\n")
        os.replace(staging, path)
    finally:
        Path(staging).unlink(missing_ok=True)


def claim(path, candidate):
    if path.exists():
        current = json.loads(path.read_text())
        return {"status": "resume" if current["owner"] == candidate["owner"] else "busy", **current}
    write_json(path, candidate)
    return {"status": "claimed", **candidate}


def owned(path, owner):
    current = json.loads(path.read_text())
    if current["owner"] != owner:
        raise ValueError("Pending release belongs to another thread; preserve it")
    return current


def github_release(version):
    pages = json.loads(run("gh", "api", "repos/netpro2k/t3code/releases?per_page=100", "--paginate", "--slurp"))
    return next((release for page in pages for release in page if release["tag_name"] == f"v{version}"), None)


def retire(directory, pending_path, owner, worktree, outcome):
    pending = json.loads(pending_path.read_text()) if pending_path.exists() else None
    if pending and pending["owner"] == owner and outcome != "published":
        raise ValueError("The owner must leave an unfinished release visible")
    if outcome == "published":
        pending = owned(pending_path, owner)
        if pending["stage"] != "ready":
            raise ValueError("Only the pinned ready candidate can complete")
        release = github_release(pending["version"])
        if not release or release["draft"] or release["prerelease"]:
            raise ValueError("Release is not published")
        published = run("gh", "api", f"repos/netpro2k/t3code/commits/v{pending['version']}", "--jq", ".sha")
        remote = run("git", "ls-remote", "origin", "refs/heads/main").split()[0]
        if published != pending["commit"] or remote != pending["commit"]:
            raise ValueError("Published tag and main must match the approved candidate")
    record = {
        "owner": owner,
        "outcome": outcome,
        "worktree": str(worktree),
        "branch": run("git", "symbolic-ref", "--short", "HEAD"),
        "commit": run("git", "rev-parse", "HEAD"),
    }
    directory.mkdir(exist_ok=True)
    write_json(directory / f"{owner}.json", record)
    if outcome == "published":
        pending_path.unlink()
    return record


def cleanup(record_path, current_worktree, common):
    record = json.loads(record_path.read_text())
    worktree = Path(record["worktree"])
    if worktree == current_worktree or worktree == common.parent:
        raise ValueError("Never remove the current or primary checkout")
    if worktree.exists():
        actual_common = Path(run("git", "rev-parse", "--path-format=absolute", "--git-common-dir", cwd=worktree)).resolve()
        if actual_common != common or worktree.is_symlink():
            raise ValueError("Retired worktree does not belong to this repository")
        if run("git", "rev-parse", "HEAD", cwd=worktree) != record["commit"]:
            raise ValueError("Retired worktree commit changed; preserve it")
        if run("git", "symbolic-ref", "--short", "HEAD", cwd=worktree) != record["branch"]:
            raise ValueError("Retired worktree branch changed; preserve it")
        if run("git", "status", "--porcelain", cwd=worktree):
            raise ValueError("Retired worktree has changes; preserve it")
        run("git", "worktree", "remove", "--", str(worktree), cwd=current_worktree)
    record_path.unlink()
    return {"status": "removed", **record}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "status", "ready", "retire", "cleanup"])
    parser.add_argument("--owner", required=True, help="Calling T3 thread ID")
    parser.add_argument("--retired-owner")
    parser.add_argument("--outcome", choices=["no-update", "busy", "published"])
    parser.add_argument("--read-only", action="store_true")
    args = parser.parse_args()
    for identity in (args.owner, args.retired_owner):
        if identity is not None and not re.fullmatch(r"[A-Za-z0-9:_-]+", identity):
            raise ValueError("Invalid thread ID")
    worktree = Path(run("git", "rev-parse", "--show-toplevel")).resolve()
    common = Path(run("git", "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    directory = common / "fork-release-automation"
    directory.mkdir(exist_ok=True)
    pending_path = directory / "pending.json"
    retired = directory / "retired"
    with coordination_lock(directory):
        if args.command == "status":
            result = {"pending": json.loads(pending_path.read_text()) if pending_path.exists() else None,
                      "retired": [json.loads(path.read_text()) for path in sorted(retired.glob("*.json"))]}
        elif args.command == "check":
            if pending_path.exists():
                pending = json.loads(pending_path.read_text())
                result = {"status": "resume" if pending["owner"] == args.owner else "busy", **pending}
            else:
                upstream = run("git", "remote", "get-url", "upstream")
                origin = run("git", "remote", "get-url", "origin")
                if not re.fullmatch(r"(?:https://github.com/|git@github.com:)pingdotgg/t3code(?:\.git)?", upstream):
                    raise ValueError("upstream is not canonical pingdotgg/t3code")
                if not re.fullmatch(r"(?:https://github.com/|git@github.com:)netpro2k/t3code(?:\.git)?", origin):
                    raise ValueError("origin is not netpro2k/t3code")
                release = json.loads(run("gh", "api", "repos/pingdotgg/t3code/releases/latest"))
                needs_release(release, [])
                run("git", "fetch", "origin", "main")
                run("git", "fetch", "upstream", "tag", release["tag_name"])
                tags = run("git", "tag", "--merged", "refs/remotes/origin/main").splitlines()
                if not needs_release(release, tags):
                    result = {"status": "current", "upstreamTag": release["tag_name"]}
                else:
                    tag = release["tag_name"]
                    version = f"{tag[1:]}-netpro2k"
                    if github_release(version) is not None:
                        raise ValueError("A release already exists without a local claim; inspect it instead of creating another")
                    candidate = {"owner": args.owner, "stage": "preparing", "upstreamTag": tag,
                                 "upstreamCommit": run("git", "rev-parse", f"{tag}^{{commit}}"),
                                 "baseCommit": run("git", "rev-parse", "refs/remotes/origin/main"),
                                 "version": version, "worktree": str(worktree)}
                    result = {"status": "available", **candidate} if args.read_only else claim(pending_path, candidate)
        elif args.command == "ready":
            pending = owned(pending_path, args.owner)
            commit = run("git", "rev-parse", "HEAD")
            if pending.get("commit", commit) != commit:
                raise ValueError("Ready candidate is immutable; do not replace it")
            release = github_release(pending["version"])
            if not release or not release["draft"] or release["target_commitish"] != commit:
                raise ValueError("A draft at the exact candidate commit is required")
            pending.update(stage="ready", commit=commit, releaseUrl=release["html_url"],
                           branch=run("git", "symbolic-ref", "--short", "HEAD"))
            write_json(pending_path, pending)
            result = pending
        elif args.command == "retire":
            if not args.outcome or worktree == common.parent:
                raise ValueError("Retire requires an outcome and a linked worktree")
            result = retire(retired, pending_path, args.owner, worktree, args.outcome)
        else:
            if not args.retired_owner or args.retired_owner == args.owner:
                raise ValueError("Cleanup requires another stopped, archived thread")
            result = cleanup(retired / f"{args.retired_owner}.json", worktree, common)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
