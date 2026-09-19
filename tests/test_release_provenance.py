import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from release_provenance import verify_marker, write_marker


class ReleaseProvenanceTests(unittest.TestCase):
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
