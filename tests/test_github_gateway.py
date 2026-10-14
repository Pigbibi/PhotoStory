import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("legacy_gateway", Path(__file__).resolve().parents[1] / "scripts/github_gateway.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
class RetiredTransportTests(unittest.TestCase):
    def test_legacy_http_client_never_requests_oidc_or_calls_service(self):
        with patch.object(gateway.urllib.request, "urlopen") as network, patch.object(gateway.subprocess, "run") as process:
            with self.assertRaisesRegex(ValueError, "setup_required"):
                gateway.main()
        network.assert_not_called()
        process.assert_not_called()
