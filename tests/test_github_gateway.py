import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import github_gateway as gateway


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class GatewayTests(unittest.TestCase):
    def test_codex_only_oidc_request_preserves_schema_and_images(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            for name, body in [('prompt.txt', b'Look at this photo.'),
                               ('schema.json', b'{"type":"object"}'),
                               ('image.jpg', b'\xff\xd8\xffimage')]:
                (work / name).write_bytes(body)
            arguments = ['gateway', '--prompt-file', str(work / 'prompt.txt'),
                         '--output-schema', str(work / 'schema.json'), '--out', str(work / 'result.json'),
                         '--image', str(work / 'image.jpg'), '--providers', 'codex',
                         '--sandbox', 'read-only', '--ask-for-approval', 'never',
                         '--complexity', 'medium', '--timeout-seconds', '600', '--cwd', tmp]
            requests = []

            def send(request, timeout):
                requests.append(request)
                if len(requests) == 1:
                    return Reply(b'{"value":"oidc-token"}')
                return Reply(b'{"status":"ok","output":"{\\"photos\\":[]}"}')

            env = {'ACTIONS_ID_TOKEN_REQUEST_URL': 'https://github.example/oidc',
                   'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'one-time-token',
                   'CODEX_GATEWAY_SERVICE_URL': 'https://gateway.example'}
            with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', arguments), \
                    patch.object(gateway.urllib.request, 'urlopen', side_effect=send):
                gateway.main()
            self.assertEqual(json.loads((work / 'result.json').read_text()), {'photos': []})
            payload = json.loads(requests[1].data)
            self.assertEqual(payload['provider_chain'], 'codex')
            self.assertEqual(payload['sandbox'], 'read-only')
            self.assertFalse(payload['search'])
            self.assertEqual(len(payload['images']), 1)
            self.assertEqual(requests[1].full_url, 'https://gateway.example/v1/codex')

    def test_invalid_service_url_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'invalid_gateway_url'):
            gateway.endpoint('http://gateway.example')


if __name__ == '__main__':
    unittest.main()
