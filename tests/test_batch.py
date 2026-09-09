import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('batch', Path(__file__).parents[1] / 'scripts/process_batch.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

class ScreeningTests(unittest.TestCase):
    def safe(self, **kw):
        return dict(id='a', decision='allow', flags=[], landscape=True, aesthetic=8, description='Coast', **kw)
    def test_uncertainty_never_enters_drafts(self):
        for change in ({'decision':'uncertain'}, {'flags':['person']}, {'landscape':False}, {'aesthetic':6}, {'aesthetic':True}, {'flags':None}):
            self.assertEqual(b.accepted_screening({'photos':[{**self.safe(), **change}]}, ['a']), [])
    def test_missing_or_unknown_ids_fail(self):
        for photos in ([], [self.safe(),self.safe()], [{**self.safe(),'id':'b'}]):
            with self.assertRaises(b.Stop): b.accepted_screening({'photos':photos},['a'])
    def test_only_explicit_safe_photo_passes(self):
        self.assertEqual(len(b.accepted_screening({'photos':[self.safe()]},['a'])),1)
    def test_upload_time_is_not_capture_time(self):
        self.assertIsNone(b.photo_time({'createdDateTime':'2026-08-20T12:00:00Z'}))
        self.assertIsNone(b.photo_time({'photo':{'takenDateTime':'2026-08-20T12:00:00'}}))
    def test_group_cannot_reintroduce_excluded_or_duplicate_photo(self):
        draft={'title':'Coast','caption':'Quiet coast.','hashtags':'#Coast','reason':'Coherent','photos':[{'id':'a','alt':'Coast'}]}
        with self.assertRaises(b.Stop): b.validated_groups({'drafts':[draft]},set(),'job')
        with self.assertRaises(b.Stop): b.validated_groups({'drafts':[draft,draft]},{'a'},'job')
    def test_model_cannot_override_draft_id(self):
        d={'id':'evil','title':'Coast','caption':'Quiet coast.','hashtags':'#Coast','reason':'Coherent','photos':[{'id':'a','alt':'Coast'}]}
        self.assertEqual(b.validated_groups({'drafts':[d]},{'a'},'job')[0]['id'],'job-1')
    def test_model_environment_has_no_host_credentials_or_configuration_injection(self):
        from unittest.mock import patch
        with patch.dict(b.os.environ, {
            "PATH": "/usr/bin", "HOME": "/restricted-home", "LANG": "C.UTF-8",
            "AWS_SECRET_ACCESS_KEY": "dummy", "PHOTOSTORY_BATCH_TOKEN": "dummy",
            "GH_TOKEN": "dummy", "LD_PRELOAD": "/untrusted.so", "PYTHONPATH": "/untrusted",
            "CODEX_GATEWAY_BACKEND": "ssh", "CODEX_GATEWAY_FAKE_RESULT": "fake",
        }, clear=True):
            env = b.gateway_environment()
        self.assertEqual(env["HOME"], "/restricted-home")
        self.assertEqual(env["CODEX_GATEWAY_BACKEND"], "local")
        for key in ("AWS_SECRET_ACCESS_KEY", "PHOTOSTORY_BATCH_TOKEN", "GH_TOKEN", "LD_PRELOAD", "PYTHONPATH", "CODEX_GATEWAY_FAKE_RESULT"):
            self.assertNotIn(key, env)
    def test_graph_pagination_cannot_exfiltrate_token(self):
        with self.assertRaises(b.Stop): b.graph('https://evil.invalid/next','secret')


class FailureReportingTests(unittest.TestCase):
    def test_only_fixed_failure_reasons_are_reported(self):
        self.assertEqual(b.failure_reason(b.Stop('photo_limit')), 'photo_limit')
        self.assertEqual(b.failure_reason(b.Stop('provider secret response')), 'unknown')
        self.assertEqual(b.failure_reason(RuntimeError('provider secret response')), 'unknown')


class CandidateTests(unittest.TestCase):
    def test_all_and_custom_scope_use_capture_time_and_only_coarse_location(self):
        item={'id':'one','parentReference':{'driveId':'drive'},'image':{},'photo':{'takenDateTime':'2026-08-26T18:00:00Z'},'location':{'latitude':13.756331,'longitude':100.501762},'eTag':'v1'}
        all_source={'start':None,'end':None}
        self.assertEqual(b.candidate(item,all_source)['area'],[13.8,100.5])
        self.assertIsNone(b.candidate(item,{'start':'2026-08-16','end':'2026-08-27'})) # 02:00 on Aug 27 in Shanghai.
        self.assertIsNone(b.candidate({**item,'photo':{}},all_source))
        self.assertIsNone(b.candidate({**item,'name':'Screenshot.png'},all_source))

if __name__=='__main__': unittest.main()
