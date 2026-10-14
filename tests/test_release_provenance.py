import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from release_provenance import artifact_manifest, deploy, verify_activity, verify_marker, write_marker


class ReleaseProvenanceTests(unittest.TestCase):
    def deployment_fixture(self, repo, *, mismatch=False, readback_failure=False):
        self.git(repo, "init", "-q")
        self.git(repo, "config", "user.email", "test@example.invalid")
        self.git(repo, "config", "user.name", "PhotoStory test")
        (repo / ".gitignore").write_text("private/\ndist/\nwrangler.local.jsonc\n")
        (repo / "README").write_text("fixture")
        (repo / "worker").mkdir()
        (repo / "worker/index.mjs").write_text("export default {};\n")
        (repo / "package-lock.json").write_text(json.dumps({"packages": {
            "node_modules/wrangler": {"version": "4.130.0"}}}))
        (repo / "wrangler.local.jsonc").write_text("private fixture config")
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-qm", "fixture")
        real_run = subprocess.run
        calls = []
        uploaded = "00000000-0000-0000-0000-000000000001"
        source = self.git(repo, "rev-parse", "HEAD")
        message = None

        def run(args, **kwargs):
            nonlocal message
            if args[0] == "git":
                return real_run(args, **kwargs)
            calls.append(args)
            output = ""
            if args[0] == "node":
                output = '{"supported":true}'
            elif args[0] == "npm":
                (repo / "dist").mkdir()
                (repo / "dist/index.html").write_bytes(b"built static fixture")
            elif "--version" in args:
                output = "4.130.0"
            elif args[1] == "deploy":
                directory = Path(args[args.index("--outdir") + 1])
                directory.mkdir()
                data = b"bundled fixture"
                if "--dry-run" not in args:
                    message = args[args.index("--message") + 1]
                    data = b"different bytes" if mismatch else data
                    output = "Current Version ID: " + uploaded
                (directory / "index.js").write_bytes(data)
            elif args[1] == "deployments":
                if readback_failure:
                    return subprocess.CompletedProcess(args, 1, "PRIVATE", "PRIVATE")
                output = json.dumps([{"id": "deployment", "created_on": "2026-10-14T10:00:00Z",
                    "versions": [{"version_id": uploaded, "percentage": 100}]}])
            elif args[1:3] == ("versions", "view"):
                output = json.dumps({"id": uploaded, "annotations": {
                    "workers/tag": source, "workers/message": message},
                    "private_field": "must not be saved"})
            return subprocess.CompletedProcess(args, 0, output, "private log not saved")

        return run, calls

    def test_deploy_rejects_hidden_tracked_changes_before_build(self):
        for flag in ["--assume-unchanged", "--skip-worktree"]:
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as tmp:
                repo = Path(tmp)
                fake, calls = self.deployment_fixture(repo)
                self.git(repo, "update-index", flag, "worker/index.mjs")
                (repo / "worker/index.mjs").write_text("export default { changed: true };\n")
                self.assertEqual(self.git(repo, "status", "--porcelain"), "")
                with patch("release_provenance.subprocess.run", side_effect=fake):
                    with self.assertRaisesRegex(ValueError, "deployment_stopped:source"):
                        deploy(repo)
                self.assertEqual(calls, [])

    def test_deploy_rechecks_hidden_index_flags_after_candidate_before_upload(self):
        for flag in ["--assume-unchanged", "--skip-worktree"]:
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as tmp:
                repo = Path(tmp)
                fake, calls = self.deployment_fixture(repo)

                def flag_after_candidate(args, **kwargs):
                    result = fake(args, **kwargs)
                    if args[1] == "deploy" and "--dry-run" in args:
                        self.git(repo, "update-index", flag, "worker/index.mjs")
                        (repo / "worker/index.mjs").write_text("export default { changed: true };\n")
                        self.assertEqual(self.git(repo, "status", "--porcelain"), "")
                    return result

                with patch("release_provenance.subprocess.run", side_effect=flag_after_candidate):
                    with self.assertRaisesRegex(ValueError, "deployment_stopped:build"):
                        deploy(repo)
                uploads = [c for c in calls if c[1] == "deploy" and "--dry-run" not in c]
                self.assertEqual(uploads, [])
                receipt = json.loads(next((repo / "private").rglob("receipt.json")).read_text())
                self.assertEqual(receipt["status"], "preparing")

    def test_deploy_receipt_binds_actual_bytes_and_filters_readback(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            fake, calls = self.deployment_fixture(repo)
            with patch("release_provenance.subprocess.run", side_effect=fake):
                result = deploy(repo)
            path = Path(result["receipt"])
            receipt = json.loads(path.read_text())
            self.assertEqual(receipt["status"], "verified")
            self.assertEqual(receipt["activity"]["percentage"], 100)
            self.assertNotIn("private", path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            uploads = [c for c in calls if c[1] == "deploy" and "--dry-run" not in c]
            self.assertEqual(len(uploads), 1)

    def test_post_upload_mismatch_or_readback_failure_stops_without_retry(self):
        for options, step in [({"mismatch": True}, "uploaded_bytes"),
                              ({"readback_failure": True}, "activity_readback")]:
            with self.subTest(step=step), tempfile.TemporaryDirectory() as tmp:
                repo = Path(tmp)
                fake, calls = self.deployment_fixture(repo, **options)
                with patch("release_provenance.subprocess.run", side_effect=fake):
                    with self.assertRaisesRegex(ValueError, "deployment_stopped:" + step):
                        deploy(repo)
                receipt = json.loads(next((repo / "private").rglob("receipt.json")).read_text())
                self.assertEqual(receipt["status"], "upload_pending")
                self.assertEqual(receipt["failed_step"], step)
                self.assertNotIn("PRIVATE", json.dumps(receipt))
                self.assertEqual(len([c for c in calls if c[1] == "deploy" and
                                      "--dry-run" not in c]), 1)

    def test_artifact_hash_uses_bytes_and_relative_names_not_build_readme(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / "index.js").write_bytes(b"export default {}")
            (output / "README.md").write_text("generated at changing time")
            first = artifact_manifest(output, worker=True)
            (output / "README.md").write_text("new time")
            self.assertEqual(first, artifact_manifest(output, worker=True))
            (output / "index.js").write_bytes(b"export default { changed: true }")
            self.assertNotEqual(first, artifact_manifest(output, worker=True))

    def test_artifacts_reject_symlink_and_unaccounted_worker_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / "index.js").write_bytes(b"bundle")
            (output / "extra.wasm").write_bytes(b"module")
            with self.assertRaisesRegex(ValueError, "worker output"):
                artifact_manifest(output, worker=True)
            (output / "extra.wasm").unlink()
            (output / "asset").symlink_to(output / "index.js")
            with self.assertRaisesRegex(ValueError, "symlink"):
                artifact_manifest(output)

    def test_activity_requires_same_uploaded_version_full_traffic_and_annotations(self):
        version = "00000000-0000-0000-0000-000000000001"
        deployment = {"id": "deployment", "created_on": "2026-10-14T10:00:00Z",
                      "versions": [{"version_id": version, "percentage": 100}]}
        view = {"id": version, "annotations": {"workers/tag": "a" * 40,
                "workers/message": "artifact-sha256:" + "b" * 64}}
        self.assertEqual(verify_activity([deployment], view, version, "a" * 40,
                         "b" * 64)["version_id"], version)
        deployment["versions"][0]["percentage"] = 50
        with self.assertRaisesRegex(ValueError, "activity"):
            verify_activity([deployment], view, version, "a" * 40, "b" * 64)
        deployment["versions"][0]["percentage"] = 100
        view["annotations"]["workers/message"] = "another artifact"
        with self.assertRaisesRegex(ValueError, "annotation"):
            verify_activity([deployment], view, version, "a" * 40, "b" * 64)

    def git(self, repo, *args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()

    def test_writes_and_verifies_exact_commit_without_source_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.email", "test@example.invalid")
            self.git(repo, "config", "user.name", "PhotoStory test")
            (repo / "README").write_text("fixture\n")
            self.git(repo, "add", "README")
            self.git(repo, "commit", "-qm", "fixture")
            commit = self.git(repo, "rev-parse", "HEAD")
            marker_path = Path(tmp) / "release-provenance.json"

            marker = write_marker(repo, marker_path)

            self.assertEqual(marker, {"format": "photostory-release-v1", "commit": commit})
            self.assertEqual(json.loads(marker_path.read_text()), marker)
            self.assertEqual(verify_marker(marker_path, commit), marker)

    def test_refuses_dirty_worktree_and_mismatched_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.email", "test@example.invalid")
            self.git(repo, "config", "user.name", "PhotoStory test")
            (repo / "README").write_text("fixture\n")
            self.git(repo, "add", "README")
            self.git(repo, "commit", "-qm", "fixture")
            marker_path = Path(tmp) / "release-provenance.json"
            (repo / "README").write_text("changed\n")

            with self.assertRaisesRegex(ValueError, "dirty"):
                write_marker(repo, marker_path)

            (repo / "README").write_text("fixture\n")
            write_marker(repo, marker_path)
            with self.assertRaisesRegex(ValueError, "does not match"):
                verify_marker(marker_path, "0" * 40)


if __name__ == "__main__":
    unittest.main()
