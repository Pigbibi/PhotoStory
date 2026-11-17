import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import direct_ai_client as direct
import process_batch as batch


class Reply:
    def __init__(self, body, *, status=200, headers=None):
        self._buf = io.BytesIO(body if isinstance(body, bytes) else body.encode('utf-8'))
        self.status = status
        self.headers = {} if headers is None else headers

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self._buf.close()

    def read(self, n=-1):
        return self._buf.read(n)


def write_jpeg(directory, name='photo-1.jpg', size=(40, 30), color='blue'):
    path = Path(directory) / name
    Image.new('RGB', size, color).save(path, format='JPEG')
    return path


SAMPLE_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['photos'],
    'properties': {
        'photos': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['id', 'score'],
                'properties': {
                    'id': {'type': 'string'},
                    'score': {'type': 'integer', 'minimum': 0, 'maximum': 10},
                },
            },
        }
    },
}


class DirectAIClientTests(unittest.TestCase):
    def test_openai_responses_api_sends_strict_schema_and_validates_range_locally(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            image = write_jpeg(cwd)
            captured = []

            def send(request, timeout):
                captured.append((request, timeout))
                return Reply(json.dumps({
                    'status': 'completed',
                    'output': [{
                        'type': 'message',
                        'content': [{
                            'type': 'output_text',
                            'text': json.dumps({'photos': [{'id': 'p1', 'score': 9}]}),
                        }],
                    }],
                }))

            opener = Mock()
            opener.open.side_effect = send
            client = direct.OpenAIDirectClient('sk-test-key', model='gpt-4.1-mini', opener=opener)
            result = client.stage_gateway('screen')(
                'screen prompt', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd,
            )
            self.assertEqual(result, {'photos': [{'id': 'p1', 'score': 9}]})
            req, timeout = captured[0]
            self.assertEqual(req.full_url, direct.DEFAULT_OPENAI_URL)
            self.assertEqual(req.get_header('Authorization'), 'Bearer sk-test-key')
            self.assertEqual(timeout, direct.REQUEST_TIMEOUT_SECONDS)
            body = json.loads(req.data.decode('utf-8'))
            self.assertEqual(body['model'], 'gpt-4.1-mini')
            score_schema = body['text']['format']['schema']['properties']['photos']['items']['properties']['score']
            self.assertNotIn('minimum', score_schema)
            self.assertNotIn('maximum', score_schema)
            self.assertEqual(body['input'][0]['content'][1]['type'], 'input_image')
            self.assertTrue(body['input'][0]['content'][1]['image_url'].startswith('data:image/jpeg;base64,'))

            # Local Draft202012Validator still rejects scores outside [0, 10].
            opener.open.side_effect = lambda r, timeout: Reply(json.dumps({
                'status': 'completed',
                'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps({'photos': [{'id': 'p1', 'score': 11}]})}]}],
            }))
            with self.assertRaises(direct.DirectAIError) as ctx:
                client.stage_gateway('screen')('screen prompt', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd)
            self.assertEqual(ctx.exception.reason, 'schema_validation_failed')

    def test_anthropic_messages_api_extracts_record_result_tool_use(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            image = write_jpeg(cwd)
            captured = []

            def send(request, timeout):
                captured.append((request, timeout))
                return Reply(json.dumps({
                    'type': 'message',
                    'stop_reason': 'tool_use',
                    'content': [{
                        'type': 'tool_use',
                        'id': 'toolu_1',
                        'name': 'record_result',
                        'input': {'photos': [{'id': 'p1', 'score': 8}]},
                    }],
                }))

            opener = Mock()
            opener.open.side_effect = send
            client = direct.AnthropicDirectClient('ant-test-key', model='claude-sonnet-4-20250514', opener=opener)
            result = client.stage_gateway('group')(
                'group prompt', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd,
            )
            self.assertEqual(result, {'photos': [{'id': 'p1', 'score': 8}]})
            req, _ = captured[0]
            self.assertEqual(req.full_url, direct.DEFAULT_ANTHROPIC_URL)
            self.assertEqual(req.get_header('X-api-key'), 'ant-test-key')
            self.assertEqual(req.get_header('Anthropic-version'), direct.ANTHROPIC_VERSION)
            body = json.loads(req.data.decode('utf-8'))
            self.assertEqual(body['tool_choice'], {'type': 'tool', 'name': 'record_result'})
            self.assertEqual(body['messages'][0]['content'][1]['source']['media_type'], 'image/jpeg')

    def test_fail_closed_on_redirects_oversized_and_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            image = write_jpeg(cwd)
            opener = Mock()
            client = direct.OpenAIDirectClient('sk-test', opener=opener)

            # NoRedirect blocks redirects natively via HTTPRedirectHandler.
            handler = direct.NoRedirect()
            with self.assertRaises(direct.DirectAIError) as redirect_err:
                handler.redirect_request(None, None, 302, 'Found', {}, 'https://evil.invalid')
            self.assertEqual(str(redirect_err.exception), 'redirect_blocked')

            opener.open.side_effect = lambda req, timeout: Reply(b'{}', status=302)
            with self.assertRaises(direct.DirectAIError) as err_302:
                client.invoke('screen', 'p', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd)
            self.assertEqual(str(err_302.exception), 'redirect_blocked')

            opener.open.side_effect = lambda req, timeout: Reply(b' ' * (direct.MAX_RESPONSE_BYTES + 1))
            with self.assertRaises(direct.DirectAIError) as err_big:
                client.invoke('screen', 'p', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd)
            self.assertEqual(str(err_big.exception), 'response_too_large')

            opener.open.side_effect = lambda req, timeout: Reply(b'{}', headers={'Content-Length': str(direct.MAX_RESPONSE_BYTES + 1)})
            with self.assertRaises(direct.DirectAIError) as err_hdr:
                client.invoke('screen', 'p', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd)
            self.assertEqual(str(err_hdr.exception), 'response_too_large')

            for bad_body in (b'not-json', b'[]', b'{"status":"completed","status":"completed"}', b'{"value":NaN}'):
                opener.open.side_effect = lambda req, timeout, b=bad_body: Reply(b)
                with self.subTest(bad_body=bad_body), self.assertRaises(direct.DirectAIError) as err_json:
                    client.invoke('screen', 'p', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd)
                self.assertEqual(err_json.exception.reason, 'invalid_json')

    def test_anthropic_rejects_wrong_tool_and_incomplete_stop_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            image = write_jpeg(cwd)
            opener = Mock()
            client = direct.AnthropicDirectClient('ant-test', opener=opener)

            opener.open.side_effect = lambda req, timeout: Reply(json.dumps({
                'type': 'message',
                'stop_reason': 'max_tokens',
                'content': [{'type': 'tool_use', 'name': 'record_result', 'input': {'photos': []}}],
            }))
            with self.assertRaises(direct.DirectAIError) as err_stop:
                client.invoke('screen', 'p', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd)
            self.assertEqual(err_stop.exception.reason, 'incomplete_response')

            opener.open.side_effect = lambda req, timeout: Reply(json.dumps({
                'type': 'message',
                'stop_reason': 'tool_use',
                'content': [{'type': 'tool_use', 'name': 'other_tool', 'input': {'photos': []}}],
            }))
            with self.assertRaises(direct.DirectAIError):
                client.invoke('screen', 'p', [{'id': 'p1'}], [image], SAMPLE_SCHEMA, cwd)

    def test_rejects_bad_endpoints_symlinks_and_non_jpeg_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            txt = cwd / 'fake.jpg'
            txt.write_bytes(b'not-a-jpeg')
            for bad_url in (
                'http://api.openai.com/v1/responses',
                'https://user@api.openai.com/v1/responses',
                'https://api.openai.com/v1/responses?k=1',
                'https://localhost/v1/responses',
                'https://127.0.0.1/v1/responses',
                'https://api.invalid/v1/responses',
            ):
                with self.subTest(bad_url=bad_url), self.assertRaises(direct.DirectAIError):
                    direct._validate_https_url(bad_url, allow_test_hosts=False)

            client = direct.OpenAIDirectClient('sk-test', opener=Mock())
            with self.assertRaises(direct.DirectAIError) as err_img:
                client.invoke('screen', 'p', [{'id': 'p1'}], [txt], SAMPLE_SCHEMA, cwd)
            self.assertEqual(err_img.exception.reason, 'invalid_image')

            link = cwd / 'link.jpg'
            real = write_jpeg(cwd, 'real.jpg')
            link.symlink_to(real)
            with self.assertRaises(direct.DirectAIError) as err_sym:
                client.invoke('screen', 'p', [{'id': 'p1'}], [link], SAMPLE_SCHEMA, cwd)
            self.assertEqual(err_sym.exception.reason, 'invalid_image')

    def test_env_selection_and_gateway_precedence(self):
        self.assertIsNone(direct.direct_client_from_env({}))
        client = direct.direct_client_from_env({'OPENAI_API_KEY': 'sk-one', 'PHOTOSTORY_OPENAI_MODEL': 'gpt-4.1'})
        self.assertIsInstance(client, direct.OpenAIDirectClient)
        self.assertEqual(client.model, 'gpt-4.1')

        client = direct.direct_client_from_env({
            'OPENAI_API_KEY': 'sk-one',
            'ANTHROPIC_API_KEY': 'ant-two',
            'PHOTOSTORY_AI_PROVIDER': 'anthropic',
            'PHOTOSTORY_ANTHROPIC_MODEL': 'claude-3-7-sonnet-latest',
        })
        self.assertIsInstance(client, direct.AnthropicDirectClient)
        self.assertEqual(client.model, 'claude-3-7-sonnet-latest')

        with self.assertRaises(direct.DirectAIError):
            direct.direct_client_from_env({'OPENAI_API_KEY': 'sk-one', 'PHOTOSTORY_AI_PROVIDER': 'unknown'})

    def test_process_batch_wires_direct_client_only_when_gateway_url_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'
            state.mkdir(mode=0o700)
            env_with_gateway = {
                'PHOTOSTORY_STATE_DIR': str(state),
                'PHOTOSTORY_URL': 'https://photo.invalid',
                'PHOTOSTORY_BATCH_TOKEN': 'synthetic',
                'OPENAI_API_KEY': 'sk-test',
                'AI_TASK_GATEWAY_URL': 'https://gateway.invalid',
            }
            with patch.dict('os.environ', env_with_gateway, clear=True), \
                 patch.object(batch, 'request') as req:
                with self.assertRaises(batch.Stop):
                    batch.main()
            req.assert_not_called()

            env_direct = {
                'PHOTOSTORY_STATE_DIR': str(state),
                'PHOTOSTORY_URL': 'https://photo.invalid',
                'PHOTOSTORY_BATCH_TOKEN': 'synthetic',
                'OPENAI_API_KEY': 'sk-test',
            }
            with patch.dict('os.environ', env_direct, clear=True), \
                 patch.object(batch, 'request', side_effect=[b'{}', b'null']) as req, \
                 patch('auto_publish.tick', return_value=False):
                batch.main()
            self.assertEqual(req.call_count, 2)


if __name__ == '__main__':
    unittest.main()
