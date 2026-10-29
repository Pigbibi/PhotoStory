import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import qualify_cloud_native as qualification
from native_tasks import NativeStopped, STAGES


class CloudQualificationTests(unittest.TestCase):
    def env(self):
        binding={'enabled':True,'project':'Pigbibi/PhotoStory','service_url':'https://personal.acme.org',
                 'audience':'https://personal.acme.org/mcp','adoption_age_seconds':3600,
                 'routes':{s:{'mode':'agent','provider':'dot','profile':s,'model':'gpt-6-sol',
                              'worker':'private-cloud-worker'} for s in STAGES}}
        return {'GITHUB_REPOSITORY':'Pigbibi/PhotoStory','GITHUB_REF':'refs/heads/main',
                'GITHUB_WORKFLOW_REF':'Pigbibi/PhotoStory/.github/workflows/processor.yml@refs/heads/main',
                'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'12345',
                'PHOTOSTORY_NATIVE_BINDING':json.dumps(binding)}

    def test_pending_task_is_adopted_by_same_id_and_receipt_excludes_private_binding(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,self.env(),clear=True):
            client=Mock(resource='https://personal.acme.org');requests=[]
            def submit(request,key):
                requests.append(request)
                return {'id':'same-task','owner':'Pigbibi/PhotoStory','provider':'dot','request':request,
                        'revision':1,'status':'queued','created':990,'updated':990,'deadline':1050}
            client.submit.side_effect=submit
            client.get.side_effect=lambda task:{'id':task,'owner':'Pigbibi/PhotoStory','provider':'dot',
                'request':requests[0],'revision':1,'status':'completed','created':990,'updated':995,
                'deadline':1050,'worker':'private-cloud-worker','attempt':'unique-attempt',
                'output':{'kind':'synthetic-test'}}
            root=Path(tmp)/'qualification'
            receipt=qualification.run(root,now=lambda:1000,sleep=lambda _:None,client_factory=lambda *_:client)
            self.assertEqual(receipt['phase'],'verified');self.assertTrue(receipt['adopted'])
            client.submit.assert_called_once();client.get.assert_called_once_with('same-task')
            raw=(root/'receipt.json').read_text()
            self.assertNotIn('private-cloud-worker',raw);self.assertNotIn('base64',raw)

    def test_lost_submit_ack_retains_unknown_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,self.env(),clear=True):
            client=Mock(resource='https://personal.acme.org');client.submit.side_effect=TimeoutError()
            root=Path(tmp)/'qualification'
            with self.assertRaises(NativeStopped):
                qualification.run(root,now=lambda:1000,sleep=lambda _:None,client_factory=lambda *_:client)
            client.submit.assert_called_once();client.get.assert_not_called()
            receipt=json.loads((root/'receipt.json').read_text())
            self.assertEqual(receipt['phase'],'unverified');self.assertIsNone(receipt['task_id'])
            self.assertFalse(receipt['adopted'])

    def test_rerun_stops_before_state_or_client(self):
        env=self.env();env['GITHUB_RUN_ATTEMPT']='2';factory=Mock()
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,env,clear=True):
            root=Path(tmp)/'qualification'
            with self.assertRaises(NativeStopped):qualification.run(root,client_factory=factory)
            self.assertFalse(root.exists());factory.assert_not_called()

    def test_changed_worker_cannot_produce_adoption(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,self.env(),clear=True):
            client=Mock(resource='https://personal.acme.org')
            client.submit.side_effect=lambda request,key:{'id':'same-task','owner':'Pigbibi/PhotoStory',
                'provider':'dot','request':request,'revision':1,'status':'completed','created':990,
                'updated':995,'deadline':1050,'worker':'another-worker','attempt':'unique',
                'output':{'kind':'synthetic-test'}}
            root=Path(tmp)/'qualification'
            with self.assertRaises(NativeStopped):
                qualification.run(root,now=lambda:1000,sleep=lambda _:None,client_factory=lambda *_:client)
            self.assertFalse(json.loads((root/'receipt.json').read_text())['adopted'])
