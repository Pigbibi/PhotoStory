import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import github_gateway as client
import process_batch as batch

REQUEST_ID = '12345678-1234-1234-1234-123456789abc'


class FailureDiagnosticsTests(unittest.TestCase):
    def test_http_error_exposes_only_status_and_valid_request_id(self):
        error = urllib.error.HTTPError('https://private.invalid/SYNTHETIC_PRIVATE', 403,
                                      'SYNTHETIC_PRIVATE', {'request-id': REQUEST_ID}, None)
        self.assertEqual(client.safe_failure_diagnostic(error),
                         {'category': 'http_403', 'http_status': 403, 'request_id': REQUEST_ID})

    def test_untrusted_fields_categories_and_request_ids_are_discarded(self):
        data = {'category': 'http_401', 'http_status': 401, 'request_id': 'SYNTHETIC_PRIVATE',
                'token': 'SYNTHETIC_PRIVATE', 'message': 'SYNTHETIC_PRIVATE'}
        self.assertEqual(client.validated_failure_diagnostic(data), {'category': 'http_401', 'http_status': 401})
        self.assertIsNone(client.validated_failure_diagnostic({'category': 'SYNTHETIC_PRIVATE'}))
        self.assertIsNone(client.validated_failure_diagnostic({'category': 'http_401', 'http_status': 403}))

    def test_timeout_invalid_json_and_setup_remain_distinct(self):
        for error, category in [(subprocess.TimeoutExpired('SYNTHETIC_PRIVATE', 1), 'timeout'),
                                (KeyError('SYNTHETIC_PRIVATE'), 'setup_required'),
                                (json.JSONDecodeError('SYNTHETIC_PRIVATE', '', 0), 'invalid_json'),
                                (RuntimeError('SYNTHETIC_PRIVATE'), 'unknown')]:
            self.assertEqual(client.safe_failure_diagnostic(error), {'category': category})

    def test_graph_logs_request_shape_and_id_without_path_query_values_or_body(self):
        error = urllib.error.HTTPError(
            'https://graph.microsoft.com/v1.0/drives/SYNTHETIC_PRIVATE/items/SYNTHETIC_PRIVATE/children?$skiptoken=SYNTHETIC_PRIVATE&$select=SYNTHETIC_PRIVATE&private=SYNTHETIC_PRIVATE',
            400, 'SYNTHETIC_PRIVATE', {},
            io.BytesIO(json.dumps({'error': {'code': 'invalidRequest', 'message': 'SYNTHETIC_PRIVATE',
                                           'innerError': {'request-id': REQUEST_ID}}}).encode()))
        output = io.StringIO()
        with redirect_stdout(output):
            batch.log_graph_failure(error)
        diagnostic = json.loads(output.getvalue().partition(': ')[2])
        self.assertEqual(diagnostic['graph_code'], 'invalidRequest')
        self.assertEqual(diagnostic['request_id'], REQUEST_ID)
        self.assertEqual(diagnostic['endpoint_kind'], 'children')
        self.assertEqual(diagnostic['query_keys'], ['$select', '$skiptoken'])
        self.assertTrue(diagnostic['paged_request'])
        self.assertNotIn('SYNTHETIC_PRIVATE', output.getvalue())

    def test_unknown_graph_code_does_not_echo_provider_content(self):
        error = urllib.error.HTTPError('https://graph.microsoft.com/v1.0/me', 400, '', {},
            io.BytesIO(b'{"error":{"code":"SYNTHETIC_PRIVATE"}}'))
        output = io.StringIO()
        with redirect_stdout(output):
            batch.log_graph_failure(error)
        self.assertIn('"graph_code": "unknown"', output.getvalue())
        self.assertNotIn('SYNTHETIC_PRIVATE', output.getvalue())

    def test_retired_gateway_never_executes_or_forwards_private_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(batch.subprocess, 'run') as run, self.assertRaisesRegex(batch.Stop, 'native_binding_required'):
                batch.gateway('synthetic', [], [], {}, Path(tmp))
            run.assert_not_called()
