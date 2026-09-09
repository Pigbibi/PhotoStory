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
    def test_graph_pagination_cannot_exfiltrate_token(self):
        with self.assertRaises(b.Stop): b.graph('https://evil.invalid/next','secret')

if __name__=='__main__': unittest.main()
