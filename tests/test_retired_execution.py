import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import process_batch

class RetiredExecutionTests(unittest.TestCase):
    def test_local_or_missing_backend_never_spawns_a_process(self):
        for backend in ("", "local", "ssh", "service"):
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                command = work / "retired"
                command.touch()
                with patch.dict(process_batch.os.environ, {"CODEX_GATEWAY_BACKEND": backend, "CODEX_GATEWAY_COMMAND": str(command)}, clear=True), patch.object(process_batch.subprocess, "run") as run:
                    with self.assertRaises(process_batch.Stop):
                        process_batch.gateway("synthetic", [], [], {}, work)
                    run.assert_not_called()
