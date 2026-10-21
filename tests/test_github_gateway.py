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
            self.assertEqual(payload['model'], 'gpt-6-sol')
            self.assertEqual(payload['sandbox'], 'read-only')
            self.assertFalse(payload['search'])
            self.assertEqual(len(payload['images']), 1)
            self.assertEqual(requests[1].full_url, 'https://gateway.example/v1/codex')
            self.assertEqual(requests[1].get_header('User-agent'), gateway.USER_AGENT)

    def test_invalid_service_url_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'invalid_gateway_url'):
            gateway.endpoint('http://gateway.example')


import smoke_gateway as smoke


class NativeQualificationTests(unittest.TestCase):
    ENV = {'GITHUB_REPOSITORY':'Pigbibi/PhotoStory', 'GITHUB_REF':'refs/heads/main',
           'GITHUB_EVENT_NAME':'workflow_dispatch', 'GITHUB_RUN_ATTEMPT':'1','NATIVE_QUALIFICATION_LEGACY_FLAGS':'false',
           'GITHUB_WORKFLOW_REF':'Pigbibi/PhotoStory/.github/workflows/processor.yml@refs/heads/main'}

    def record(self, *, status='queued'):
        return {'id':'11111111-1111-4111-8111-111111111111','owner':smoke.PROJECT,
          'provider':'dot','request':smoke.request_body(),'revision':1,'created':100.0,
          'deadline':160.0,'updated':120.0 if status=='completed' else 100.0,
          'status':status,'result_kind':'advisory','worker':'dot-personal' if status=='completed' else None,
          'attempt':smoke.ATTEMPT if status=='completed' else None,
          'output':{'kind':'synthetic-test'} if status=='completed' else None}

    def prepare(self, root):
        smoke.prepare(root, environ=self.ENV)

    def test_fixture_is_original_generated_image_and_schema(self):
        import base64,hashlib
        from PIL import Image
        self.assertEqual(smoke.IDEMPOTENCY,'photostory:native-qualification:20261021:v2')
        self.assertEqual(smoke.ATTEMPT,'ps-native-qualification-20261021-v2')
        self.assertEqual(smoke.digest(smoke.request_body()),'0b81c2621197fd1809c162838fa13ee4cb841c3c74adfb29b8f9a8796d8c0c81')
        request=smoke.request_body();image=request['materials'][0]['images'][0]
        raw=base64.b64decode(image['base64'],validate=True)
        with Image.open(io.BytesIO(raw)) as im:
            self.assertEqual(im.size,(32,32));self.assertEqual(im.format,'JPEG');self.assertFalse(im.getexif())
        self.assertEqual(hashlib.sha256(raw).hexdigest(),image['sha256'])
        self.assertEqual(request['timeout_seconds'],60);self.assertEqual(request['profile'],'screen')
        self.assertEqual(request['output_schema'],smoke.SCHEMA)

    def test_non_main_or_wrong_workflow_or_rerun_stops_before_state(self):
        for key,value in [('GITHUB_REPOSITORY','Pigbibi/Other'),('GITHUB_REF','refs/heads/feature'),
                          ('GITHUB_EVENT_NAME','schedule'),('GITHUB_RUN_ATTEMPT','2'),
                          ('GITHUB_WORKFLOW_REF','Pigbibi/PhotoStory/.github/workflows/ci.yml@refs/heads/main'),
                          ('NATIVE_QUALIFICATION_LEGACY_FLAGS','true')]:
            with self.subTest(key=key),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'state'
                with self.assertRaises(smoke.Stopped):smoke.prepare(root,environ={**self.ENV,key:value})
                self.assertFalse(root.exists())

    def test_submit_intent_precedes_one_request_and_replay_stops(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock()
            def submit(request,key):
                self.assertEqual(smoke.read_receipt(root)['phase'],'intent')
                self.assertEqual(key,smoke.IDEMPOTENCY);self.assertEqual(request,smoke.request_body())
                return self.record()
            client.submit.side_effect=submit
            result=smoke.execute(root,client,'submit',environ=self.ENV,now=lambda:130)
            self.assertEqual(result['task_id'],self.record()['id']);self.assertEqual(result['attempt_id'],smoke.ATTEMPT)
            with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'submit',environ=self.ENV)
            self.assertEqual(client.submit.call_count,1);client.get.assert_not_called();client.cancel.assert_not_called()

    def test_unknown_submit_never_retries_or_polls(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock();client.submit.side_effect=TimeoutError('PRIVATE')
            with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'submit',environ=self.ENV)
            self.assertEqual(smoke.read_receipt(root)['phase'],'unknown')
            with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'submit',environ=self.ENV)
            self.assertEqual(client.submit.call_count,1);client.get.assert_not_called();client.cancel.assert_not_called()

    def test_one_readback_validates_completed_advisory(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock();record=self.record(status='completed');client.get.return_value=record
            result=smoke.execute(root,client,'readback',task_id=record['id'],environ=self.ENV,now=lambda:130)
            self.assertEqual(result['phase'],'verified');self.assertEqual(result['output'],{'kind':'synthetic-test'})
            client.get.assert_called_once_with(record['id']);client.submit.assert_not_called();client.cancel.assert_not_called()

    def test_wrong_binding_and_schema_are_not_adopted(self):
        from unittest.mock import Mock
        cases=[('owner','Pigbibi/Other'),('provider','grok'),('worker','other'),('attempt','other'),('status','other'),
               ('revision',2),('revision',True),('deadline',161),('updated',161),('created',float('nan')),
               ('request',{}),('output',{'kind':'other'}),('output',{'kind':'synthetic-test','extra':True})]
        for field,value in cases:
            with self.subTest(field=field,value=str(value)),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'state';self.prepare(root);client=Mock();record=self.record(status='completed');record[field]=value;client.get.return_value=record
                with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'readback',task_id=self.record()['id'],environ=self.ENV,now=lambda:130)
                client.submit.assert_not_called();client.cancel.assert_not_called();self.assertEqual(client.get.call_count,1)

    def test_pending_does_not_poll_and_cancel_requested_is_not_stopped(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock();record=self.record();client.get.return_value=record
            result=smoke.execute(root,client,'readback',task_id=record['id'],environ=self.ENV,now=lambda:130)
            self.assertEqual(result['phase'],'pending');client.get.assert_called_once();client.submit.assert_not_called()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock();client.get.return_value=record
            client.cancel.return_value={**record,'status':'cancel_requested'}
            result=smoke.execute(root,client,'cancel',task_id=record['id'],environ=self.ENV,now=lambda:130)
            self.assertEqual(result['phase'],'cancel_requested');self.assertFalse(result['worker_stopped'])
            client.cancel.assert_called_once_with(record['id']);client.get.assert_called_once();client.submit.assert_not_called()

    def test_missing_known_id_and_tampered_intent_do_no_network(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock()
            with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'readback',environ=self.ENV)
            receipt=smoke.read_receipt(root);receipt['request_sha256']='0'*64
            (root/'receipt.json').write_text(json.dumps(receipt))
            with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'submit',environ=self.ENV)
            self.assertFalse(client.mock_calls)

    def test_reviewed_client_drift_and_symlink_are_rejected_before_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'github_gateway.py').write_text('raise Exception("PRIVATE")')
            with self.assertRaises(smoke.Stopped):smoke.load_client(root)
            (root/'github_gateway.py').unlink();(root/'github_gateway.py').symlink_to(Path(__file__))
            with self.assertRaises(smoke.Stopped):smoke.load_client(root)

    def test_uncertain_read_cannot_become_a_new_submission(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock();client.get.side_effect=TimeoutError('PRIVATE')
            with self.assertRaises(TimeoutError):smoke.execute(root,client,'readback',task_id=self.record()['id'],environ=self.ENV)
            with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'submit',environ=self.ENV)
            client.submit.assert_not_called();self.assertEqual(smoke.read_receipt(root)['task_id'],self.record()['id'])

    def test_outcome_unknown_is_not_a_terminal_observation(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock()
            record=self.record(status='outcome_unknown');client.get.return_value=record
            result=smoke.execute(root,client,'cancel',task_id=record['id'],environ=self.ENV,now=lambda:130)
            self.assertEqual(result['phase'],'unknown')
            self.assertFalse(result['terminal_status_observed']);self.assertFalse(result['worker_stopped'])
            client.get.assert_called_once();client.cancel.assert_not_called();client.submit.assert_not_called()

    def test_original_task_clock_cannot_be_rebased_by_readback_or_cancel(self):
        from unittest.mock import Mock
        for action in ('readback','cancel'):
            with self.subTest(action=action),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'state';self.prepare(root);client=Mock();original=self.record()
                client.submit.return_value=original
                smoke.execute(root,client,'submit',environ=self.ENV,now=lambda:130)
                changed={**self.record(status='completed'),'created':3700.,'deadline':3760.,'updated':3720.}
                client.get.return_value=changed
                with self.assertRaises(smoke.Stopped):
                    smoke.execute(root,client,action,task_id=original['id'],environ=self.ENV,now=lambda:3730)
                saved=smoke.read_receipt(root)
                self.assertEqual((saved['created'],saved['deadline']),(100.,160.))
                self.assertNotEqual(saved['phase'],'verified');client.cancel.assert_not_called()

    def test_first_read_clock_is_retained_and_cancel_cannot_change_it(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state';self.prepare(root);client=Mock();record=self.record()
            client.get.return_value=record
            client.cancel.return_value={**record,'created':110.,'deadline':170.,'updated':120.,'status':'cancelled'}
            with self.assertRaises(smoke.Stopped):
                smoke.execute(root,client,'cancel',task_id=record['id'],environ=self.ENV,now=lambda:130)
            saved=smoke.read_receipt(root)
            self.assertEqual((saved['created'],saved['deadline']),(100.,160.))
            self.assertEqual(saved['phase'],'cancel_intent');self.assertTrue(saved['cancel_sent'])
            with self.assertRaises(smoke.Stopped):
                smoke.execute(root,client,'cancel',task_id=record['id'],environ=self.ENV,now=lambda:130)
            client.cancel.assert_called_once();client.submit.assert_not_called()

    def test_failure_projection_preserves_unknown_without_private_error_data(self):
        import urllib.error,urllib.request
        from types import SimpleNamespace
        from unittest.mock import Mock
        private='PRIVATE_TOKEN_QUERY_BODY_IMAGE'
        cases=[('connection',urllib.error.URLError(private),None),
               ('http',urllib.error.HTTPError('https://private.invalid/?'+private,403,private,{},None),403),
               ('parse',None,200),('task_unknown',RuntimeError(private),None)]
        for category,error,status in cases:
            with self.subTest(category=category),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'state';self.prepare(root);client=Mock()
                def wire(*args,**kwargs):
                    if error is not None:raise error
                    return SimpleNamespace(status=200)
                client.opener=SimpleNamespace(open=wire);smoke._observe_http(client)
                def submit(*args):
                    if category=='task_unknown':raise error
                    request=urllib.request.Request(smoke.SERVICE+'/v1/tasks',data=private.encode(),
                        headers={'Authorization':'Bearer '+private},method='POST')
                    try:client.opener.open(request,timeout=45)
                    except urllib.error.HTTPError:raise ValueError('native_http_rejected') from None
                    raise ValueError('invalid_json')
                client.submit.side_effect=submit
                with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'submit',environ=self.ENV)
                receipt=smoke.read_receipt(root);failure=receipt['failure']
                self.assertEqual(receipt['phase'],'unknown');self.assertIsNone(receipt['task_id'])
                self.assertEqual(failure['category'],category)
                self.assertEqual(failure['stage'],'not_observed' if category=='task_unknown' else 'task_submit')
                self.assertEqual(failure.get('http_status'),status)
                self.assertEqual(failure['task_outcome'],'unknown')
                self.assertNotIn(private,json.dumps(receipt));self.assertNotIn(smoke.IMAGE_BASE64,json.dumps(receipt))
                with self.assertRaises(smoke.Stopped):smoke.execute(root,client,'submit',environ=self.ENV)
                self.assertEqual(client.submit.call_count,1);client.get.assert_not_called();client.cancel.assert_not_called()

    def test_http_observer_keeps_only_fixed_stage_and_status(self):
        import urllib.request
        from types import SimpleNamespace
        from unittest.mock import Mock
        task=self.record()['id'];response=SimpleNamespace(status=200);wire=Mock(return_value=response)
        client=SimpleNamespace(opener=SimpleNamespace(open=wire));smoke._observe_http(client)
        cases=[('GET','https://run.actions.githubusercontent.com/oidc?secret=PRIVATE','oidc'),
               ('POST',smoke.SERVICE+'/v1/tasks','task_submit'),
               ('GET',smoke.SERVICE+'/v1/tasks/'+task,'task_read'),
               ('POST',smoke.SERVICE+'/v1/tasks/'+task+'/cancel','task_cancel'),
               ('GET','https://private.invalid/PRIVATE','not_observed')]
        for method,url,stage in cases:
            with self.subTest(stage=stage):
                request=urllib.request.Request(url,method=method)
                self.assertIs(client.opener.open(request,timeout=45),response)
                wire.assert_called_with(request,timeout=45)
                self.assertEqual(client._qualification_wire,{'stage':stage,'http_status':200})
                self.assertNotIn('PRIVATE',json.dumps(client._qualification_wire))

    def test_read_and_cancel_failures_keep_original_identity_and_send_limits(self):
        from unittest.mock import Mock
        for action in ('readback','cancel'):
            with self.subTest(action=action),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'state';self.prepare(root);client=Mock();record=self.record()
                client.get.return_value=record
                if action=='readback':client.get.side_effect=TimeoutError('PRIVATE')
                else:client.cancel.side_effect=TimeoutError('PRIVATE')
                with self.assertRaises(TimeoutError):
                    smoke.execute(root,client,action,task_id=record['id'],environ=self.ENV,now=lambda:130)
                receipt=smoke.read_receipt(root)
                self.assertEqual(receipt['task_id'],record['id']);self.assertEqual(receipt['failure']['category'],'connection')
                self.assertNotIn('PRIVATE',json.dumps(receipt));client.submit.assert_not_called()
                if action=='cancel':
                    self.assertTrue(receipt['cancel_sent'])
                    with self.assertRaises(smoke.Stopped):
                        smoke.execute(root,client,'cancel',task_id=record['id'],environ=self.ENV)
                    client.cancel.assert_called_once()

    def test_failure_metadata_rejects_arbitrary_values_and_handles_raw_http(self):
        import urllib.error
        from types import SimpleNamespace
        client=SimpleNamespace(_qualification_wire={'stage':['PRIVATE'],'category':{'PRIVATE':True},
            'http_status':True,'url':'https://PRIVATE','response':'PRIVATE'})
        result=smoke.failure_projection(client,RuntimeError('PRIVATE'))
        self.assertEqual(result,{'category':'task_unknown','stage':'not_observed','code':'unknown_error','task_outcome':'unknown'})
        error=urllib.error.HTTPError('https://PRIVATE',401,'PRIVATE',{'Set-Cookie':'PRIVATE'},None)
        result=smoke.failure_projection(client,error)
        self.assertEqual(result,{'category':'http','stage':'not_observed','code':'native_http_rejected',
                                 'task_outcome':'unknown','http_status':401})
        self.assertNotIn('PRIVATE',json.dumps(result))

    def test_qualification_job_has_no_business_secret_or_processing_step(self):
        text=(Path(__file__).parents[1]/'.github/workflows/processor.yml').read_text()
        job=text.split('\n  native_qualification:',1)[1]
        for forbidden in ('secrets.','cloud_inventory','process_batch.py','auto_publish','/v1/codex'):
            with self.subTest(forbidden=forbidden):self.assertNotIn(forbidden,job)
        self.assertIn("inputs.native_qualification != true",text)
        self.assertIn("inputs.native_qualification == true",job)


if __name__ == '__main__':
    unittest.main()
