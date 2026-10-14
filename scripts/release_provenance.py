#!/usr/bin/env python3
"""Create and verify a non-sensitive PhotoStory deployment revision marker."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

FORMAT = "photostory-release-v1"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def artifact_manifest(directory: Path, *, worker: bool = False) -> dict:
    """Hash built inputs, never configuration, bindings, logs or source maps.

    This deployment supports the existing single JavaScript Worker bundle.
    Fail rather than attest an unaccounted module or assets ignored by Wrangler.
    """
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("invalid artifact directory")
    files = []
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError("artifact symlink")
        if not path.is_file():
            continue
        name = path.relative_to(directory).as_posix()
        if worker and name in {"README.md", "index.js.map"}:
            continue  # Wrangler's timestamped README and non-uploaded source map.
        if any(part.startswith(".") for part in path.relative_to(directory).parts):
            raise ValueError("hidden asset requires explicit upload manifest")
        files.append({"path": name, "bytes": path.stat().st_size,
                      "sha256": digest(path.read_bytes())})
    if not files or (worker and [f["path"] for f in files] != ["index.js"]):
        raise ValueError("unsupported worker output" if worker else "empty assets")
    return {"files": files, "sha256": digest(json.dumps(files, sort_keys=True,
            separators=(",", ":")).encode())}


def verify_activity(deployments: list, version: dict, uploaded: str,
                    source: str, artifact: str) -> dict:
    if not deployments:
        raise ValueError("missing activity readback")
    latest = max(deployments, key=lambda d: d["created_on"])
    if latest["versions"] != [{"version_id": uploaded, "percentage": 100}]:
        raise ValueError("activity does not match uploaded version at 100 percent")
    annotations = version.get("annotations", {})
    if version.get("id") != uploaded or annotations.get("workers/tag") != source or \
            annotations.get("workers/message") != "artifact-sha256:" + artifact:
        raise ValueError("version annotation does not match artifact")
    return {"deployment_id": latest["id"], "version_id": uploaded,
            "percentage": 100, "created_on": latest["created_on"]}


def private_json(path: Path, value: dict) -> None:
    # Receipt directory is created mode 0700; no private subprocess body is saved.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".receipt-", delete=False) as handle:
        json.dump(value, handle, sort_keys=True, indent=2)
        handle.write("\n")
        temp = Path(handle.name)
    os.chmod(temp, 0o600)
    temp.replace(path)


def deploy(repo: Path) -> dict:
    """One upload, exact local built-byte checks, then metadata-only readback.

    A pending receipt means remote state may have changed: never retry it blindly.
    This does not attest bindings, provider health or historical deployments.
    """
    repo = repo.resolve()
    step = "source"
    receipt = {"format": "photostory-deploy-v1", "status": "preparing"}
    receipt_path = None

    def run(*args: str) -> str:
        result = subprocess.run(args, cwd=repo, capture_output=True, text=True,
                                env={**os.environ, "WRANGLER_SEND_METRICS": "false",
                                     "WRANGLER_HIDE_BANNER": "true", "CI": "true"})
        if result.returncode:
            # Wrangler output can contain account names/bindings; never relay it.
            raise ValueError("command_failed")
        return result.stdout.strip()

    def deployment_source() -> str:
        # status omits tracked changes hidden by assume-unchanged/skip-worktree.
        # Reject those index flags without changing the user's Git protections.
        entries = run("git", "ls-files", "-v", "-z").split("\0")
        if any(entry and not entry.startswith("H ") for entry in entries):
            raise ValueError("hidden_index_flags")
        return marker_for(repo)["commit"]

    try:
        source = deployment_source()
        tree = run("git", "rev-parse", "HEAD^{tree}")
        lock = repo / "package-lock.json"
        config = repo / "wrangler.local.jsonc"
        if config.is_symlink() or not config.is_file():
            raise ValueError("original_local_config_required")
        lock_hash, config_hash = digest(lock.read_bytes()), digest(config.read_bytes())
        wrangler = str(repo / "node_modules/.bin/wrangler")
        # Consume original config in-process; emit only supported shape booleans.
        shape = json.loads(run("node", "--input-type=module", "-e", """
import {unstable_readConfig} from 'wrangler';
import path from 'node:path';
const c=unstable_readConfig({config:'wrangler.local.jsonc'});
console.log(JSON.stringify({supported:
 c.main===path.resolve('worker/index.mjs') &&
 path.resolve(c.assets?.directory ?? '')===path.resolve('dist') &&
 !c.build?.command && !c.site && !c.no_bundle &&
 !c.upload_source_maps && !c.find_additional_modules &&
 !c.rules?.length && !Object.keys(c.define ?? {}).length &&
 !Object.keys(c.alias ?? {}).length}));
"""))
        if shape != {"supported": True}:
            raise ValueError("unsupported_build_shape")
        wrangler_version = run(wrangler, "--version")
        expected = json.loads(lock.read_text())["packages"]["node_modules/wrangler"]["version"]
        if not re.search(r"\b" + re.escape(expected) + r"\b", wrangler_version):
            raise ValueError("wrangler_lock_mismatch")
        # Fresh ignored private output; do not overwrite an earlier receipt.
        parent = repo / "private/deploy-receipts"
        if (repo / "private").is_symlink() or parent.is_symlink():
            raise ValueError("receipt_symlink")
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(parent, 0o700)
        output = Path(tempfile.mkdtemp(prefix=source + "-", dir=parent))
        receipt_path = output / "receipt.json"
        receipt.update(source=source, tree=tree, lock_sha256=lock_hash,
                       config_sha256=config_hash, wrangler_version=expected)
        private_json(receipt_path, receipt)
        step = "build"
        run("npm", "run", "build")
        candidate = output / "candidate"
        actual = output / "actual"
        run(wrangler, "deploy", "--config", "wrangler.local.jsonc", "--dry-run",
            "--outdir", str(candidate))
        worker = artifact_manifest(candidate, worker=True)
        assets = artifact_manifest(repo / "dist")
        artifacts = {"worker": worker, "assets": assets}
        artifact_hash = digest(json.dumps(artifacts, sort_keys=True,
                               separators=(",", ":")).encode())
        receipt.update(artifacts=artifacts, artifact_sha256=artifact_hash)

        def unchanged():
            if deployment_source() != source or \
                    digest(lock.read_bytes()) != lock_hash or \
                    digest(config.read_bytes()) != config_hash or \
                    artifact_manifest(repo / "dist") != assets:
                raise ValueError("inputs_changed")

        unchanged()
        step = "upload"
        # Write pending before the only remote mutation. On error, stop; no retry.
        receipt["status"] = "upload_pending"
        private_json(receipt_path, receipt)
        uploaded_output = run(wrangler, "deploy", "--config", "wrangler.local.jsonc",
                              "--outdir", str(actual), "--tag", source,
                              "--message", "artifact-sha256:" + artifact_hash)
        step = "uploaded_bytes"
        unchanged()
        if artifact_manifest(actual, worker=True) != worker:
            raise ValueError("uploaded_bundle_mismatch")
        matches = re.findall(r"(?:Worker Version ID|Current Version ID):\s*"
                             r"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})",
                             uploaded_output)
        if len(set(matches)) != 1:
            raise ValueError("uploaded_version_unknown")
        uploaded = matches[0]
        receipt["uploaded_version_id"] = uploaded
        step = "activity_readback"
        deployments = json.loads(run(wrangler, "deployments", "list", "--config",
                                     "wrangler.local.jsonc", "--json"))
        version = json.loads(run(wrangler, "versions", "view", uploaded, "--config",
                                 "wrangler.local.jsonc", "--json"))
        activity = verify_activity(deployments, version, uploaded, source, artifact_hash)
        unchanged()
        receipt.update(status="verified", activity=activity)
        private_json(receipt_path, receipt)
        return {"status": "verified", "source": source, "artifact_sha256": artifact_hash,
                "receipt": str(receipt_path)}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        if receipt_path:
            receipt["failed_step"] = step
            private_json(receipt_path, receipt)
        raise ValueError("deployment_stopped:" + step + ":no_automatic_retry") from None


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

    upload = subparsers.add_parser("deploy", help="deploy once with a private provenance receipt")
    upload.add_argument("--repo", type=Path, default=Path.cwd())

    args = parser.parse_args()
    try:
        if args.command == "deploy":
            marker = deploy(args.repo)
        else:
            marker = write_marker(args.repo, args.output) if args.command == "write" else verify_marker(args.marker, args.commit)
    except (OSError, subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps(marker, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
