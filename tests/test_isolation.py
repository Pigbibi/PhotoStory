import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'scripts/systemd_gateway.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

class BridgeTests(unittest.TestCase):
    def test_bounded_regular_files_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'file'
            p.write_bytes(b'1234')
            self.assertEqual(b.read_regular(p, 4), b'1234')
            with self.assertRaises(ValueError): b.read_regular(p, 3)
            link = Path(tmp) / 'link'
            link.symlink_to(p)
            with self.assertRaises(OSError): b.read_regular(link, 4)

    def test_failed_or_stale_service_reply_cleans_private_inputs(self):
        for returncode in (0, 1):
            with self.subTest(returncode=returncode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root/'input').mkdir()
                (root/'output').mkdir()
                for name, value in [('prompt',b'private prompt'),('schema',b'{}'),('image',b'\xff\xd8\xffprivate')]:
                    (root/name).write_bytes(value)
                (root/'output/response.json').write_text(json.dumps({'id':'stale','body':{}}))
                args = SimpleNamespace(image=[str(root/'image')],prompt_file=root/'prompt',output_schema=root/'schema',out=root/'result')
                with patch.object(b,'BRIDGE',root), patch.object(b,'parse_args',return_value=args), patch.object(b.subprocess,'run',return_value=SimpleNamespace(returncode=returncode)):
                    with self.assertRaises(ValueError): b.main()
                self.assertFalse((root/'result').exists())
                self.assertEqual([p.name for p in (root/'input').iterdir()], ['client.lock'])


class RuntimeModes(unittest.TestCase):
    def test_modes_and_unknown_mode(self):
        import sys
        with patch.dict(sys.modules, {'systemd_gateway': b}):
            spec = importlib.util.spec_from_file_location('runtime', Path(__file__).parents[1] / 'scripts/run_isolated_ai.py')
            runtime = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runtime)
        work = Path('/example')
        direct = runtime.command_for('codex-cli', work, 2)
        self.assertEqual(direct[-1], '-')
        self.assertEqual(direct.count('--image'), 2)
        self.assertNotIn('/opt/codex-gateway/bin/codex-gateway', direct)
        gateway = runtime.command_for('aigateway-cli', work, 2)
        self.assertEqual(gateway[gateway.index('--providers') + 1], 'codex')
        self.assertEqual(gateway.count('--image'), 2)
        with self.assertRaises(ValueError): runtime.command_for('unknown', work, 2)

class ExistingAuth(unittest.TestCase):
    def test_snapshot_has_no_refresh_authority_and_rejects_expiry(self):
        import sys, base64, time
        with patch.dict(sys.modules, {'systemd_gateway': b}):
            spec = importlib.util.spec_from_file_location('runtime', Path(__file__).parents[1] / 'scripts/run_isolated_ai.py')
            runtime = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runtime)
        def source(exp):
            payload = base64.urlsafe_b64encode(json.dumps({'exp':exp}).encode()).decode().rstrip('=')
            return {'tokens': {'access_token':'x.'+payload+'.x','id_token':'dummy','refresh_token':'must-not-copy','account_id':'dummy'}}
        original = source(time.time()+3600)
        result = runtime.access_snapshot(original)
        self.assertEqual(result['tokens']['refresh_token'], '')
        self.assertNotIn('must-not-copy', json.dumps(result))
        self.assertEqual(original['tokens']['refresh_token'], 'must-not-copy')
        with self.assertRaises(ValueError): runtime.access_snapshot(source(time.time()+300))

if __name__ == '__main__': unittest.main()
