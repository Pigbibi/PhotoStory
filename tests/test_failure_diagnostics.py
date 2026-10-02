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

    def test_failed_gateway_forwards_only_validated_client_diagnostic(self):
        self.gateway_failure(subprocess.CompletedProcess([], 1,
            stdout=b'Gateway diagnostic: {"category":"http_403","http_status":403,"message":"SYNTHETIC_PRIVATE"}\n',
            stderr=b'SYNTHETIC_PRIVATE'), 'http_403')

    def test_gateway_timeout_has_a_fixed_reason(self):
        self.gateway_failure(subprocess.TimeoutExpired('SYNTHETIC_PRIVATE', 1), 'timeout', timeout=True)

    def test_missing_oversized_and_invalid_outputs_remain_distinct(self):
        for content, category in [(None, 'output_missing'), ('x' * 100_001, 'gateway_result_invalid'),
                                  ('SYNTHETIC_PRIVATE', 'invalid_json')]:
            with self.subTest(category=category), tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                command = work / 'gateway'
                command.write_text('synthetic')
                def result(*args, **kwargs):
                    if content is not None:
                        (work / 'result.json').write_text(content)
                    return subprocess.CompletedProcess([], 0, stdout=b'', stderr=b'')
                output = io.StringIO()
                with patch.dict(os.environ, {'CODEX_GATEWAY_COMMAND': str(command)}, clear=True), \
                        patch.object(batch.subprocess, 'run', side_effect=result), redirect_stdout(output), \
                        self.assertRaisesRegex(batch.Stop, 'gateway_failed'):
                    batch.gateway('synthetic', [], [], {}, work)
                self.assertIn(category, output.getvalue())
                self.assertNotIn('SYNTHETIC_PRIVATE', output.getvalue())

    def gateway_failure(self, result, category, *, timeout=False):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            command = work / 'gateway'
            command.write_text('synthetic')
            output = io.StringIO()
            options = {'side_effect': result} if timeout else {'return_value': result}
            with patch.dict(os.environ, {'CODEX_GATEWAY_COMMAND': str(command)}, clear=True), \
                    patch.object(batch.subprocess, 'run', **options), redirect_stdout(output), \
                    self.assertRaisesRegex(batch.Stop, 'gateway_timeout' if timeout else 'gateway_failed'):
                batch.gateway('synthetic', [], [], {}, work)
            self.assertIn(category, output.getvalue())
            self.assertNotIn('SYNTHETIC_PRIVATE', output.getvalue())
