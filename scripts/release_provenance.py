#!/usr/bin/env python3
"""Create and verify a non-sensitive PhotoStory deployment revision marker."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

FORMAT = "photostory-release-v1"


def git_revision(repo: Path) -> tuple[str, bool]:
    """Return the exact HEAD revision and whether the worktree has changes."""
    def git(*args: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
        )
        return result.stdout.strip()

    revision = git("rev-parse", "HEAD")
    dirty = bool(git("status", "--porcelain"))
    if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
        raise ValueError("git revision is not a full commit id")
    return revision, dirty


def marker_for(repo: Path) -> dict[str, object]:
    revision, dirty = git_revision(repo)
    if dirty:
        raise ValueError("refusing to mark a dirty worktree")
    return {"format": FORMAT, "commit": revision}


def write_marker(repo: Path, output: Path) -> dict[str, object]:
    marker = marker_for(repo)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=output.parent, prefix=f".{output.name}.", delete=False
    ) as handle:
        json.dump(marker, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        temp_path = Path(handle.name)
    temp_path.replace(output)
    return marker


def verify_marker(marker_path: Path, expected_commit: str) -> dict[str, object]:
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    if marker.get("format") != FORMAT or set(marker) != {"format", "commit"}:
        raise ValueError("unsupported release marker")
    commit = marker.get("commit")
    if not isinstance(commit, str) or len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        raise ValueError("invalid commit in release marker")
    if expected_commit != commit:
        raise ValueError("release marker commit does not match expected commit")
    return marker


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    write = subparsers.add_parser("write", help="write a marker from a clean Git worktree")
    write.add_argument("--repo", type=Path, default=Path.cwd())
    write.add_argument("--output", type=Path, required=True)

    verify = subparsers.add_parser("verify", help="verify a marker against an expected commit")
    verify.add_argument("--marker", type=Path, required=True)
    verify.add_argument("--commit", required=True)

    args = parser.parse_args()
    try:
        marker = write_marker(args.repo, args.output) if args.command == "write" else verify_marker(args.marker, args.commit)
    except (OSError, subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps(marker, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
