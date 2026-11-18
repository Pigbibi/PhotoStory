import json
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import qualify_cloud_native as qualification
from native_tasks import NativeStopped, STAGES


class CloudQualificationTests(unittest.TestCase):
    def test_muse_generated_image_compares_the_observed_color(self):
        for color in ('blue', 'red'):
            with self.subTest(color=color), tempfile.TemporaryDirectory() as tmp:
                config = self.env() | {'PHOTOSTORY_MUSE_SCREEN_BINDING': json.dumps({
                    'job_id': 'synthetic-job', 'model': 'synthetic-muse', 'worker': 'fixture-worker'})}
                client = Mock(resource='https://personal.acme.org')
                client.submit.side_effect = lambda request, _: {
                    'id': 'original-task', 'owner': 'Pigbibi/PhotoStory', 'provider': 'muse',
                    'request': request, 'revision': 1, 'status': 'completed',
                    'created': 990, 'updated': 995, 'deadline': 1590, 'worker': 'fixture-worker',
                    'attempt': 'one-attempt', 'output': {'color': color},
                }
                root = Path(tmp)/'qualification'
                with patch.dict(os.environ, config, clear=True):
                    kwargs = {'use_muse': True, 'now': lambda: 1000, 'client_factory': lambda *_: client}
                    if color == 'blue':
                        self.assertEqual(qualification.run(root, **kwargs)['phase'], 'verified')
                    else:
                        with self.assertRaises(qualification.QualificationUnverified):
                            qualification.run(root, **kwargs)
                request = client.submit.call_args.args[0]
                self.assertEqual((request['profile'], request['timeout_seconds']), ('muse-screen', 600))
                self.assertNotIn('blue', request['objective'])
                client.submit.assert_called_once()

    def test_neutral_screen_binding_qualifies_custom_project_and_async_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            binding = {
                'enabled': True, 'project': 'CustomOrg/PhotoStoryFork',
                'service_url': 'https://personal.acme.org', 'audience': 'https://personal.acme.org/mcp',
                'adoption_age_seconds': 3600,
                'routes': {s: {'mode': 'api', 'provider': 'custom-vision', 'profile': s,
                               'model': 'gpt-4.1-mini', 'worker': 'cloud-worker'} for s in STAGES},
            }
            config = {
                'GITHUB_REPOSITORY': 'CustomOrg/PhotoStoryFork',
                'GITHUB_REF': 'refs/heads/main',
                'GITHUB_WORKFLOW_REF': 'CustomOrg/PhotoStoryFork/.github/workflows/processor.yml@refs/heads/main',
                'GITHUB_EVENT_NAME': 'workflow_dispatch',
                'GITHUB_RUN_ATTEMPT': '1',
                'GITHUB_RUN_ID': '12345',
                'PHOTOSTORY_NATIVE_BINDING': json.dumps(binding),
                'PHOTOSTORY_SCREEN_BINDING': json.dumps({
                    'job_id': 'synthetic-job', 'provider': 'async-vision',
                    'model': 'vision-v1', 'worker': 'fixture-worker', 'mode': 'api',
                }),
            }
            client = Mock(resource='https://personal.acme.org')
            client.submit.side_effect = lambda request, _: {
                'id': 'original-task', 'owner': 'CustomOrg/PhotoStoryFork', 'provider': 'async-vision',
                'request': request, 'revision': 1, 'status': 'completed',
                'created': 990, 'updated': 995, 'deadline': 1590, 'worker': 'fixture-worker',
                'attempt': 'one-attempt', 'output': {'color': 'blue'},
            }
            root = Path(tmp) / 'qualification'
            with patch.dict(os.environ, config, clear=True):
                receipt = qualification.run(root, use_screen_route=True, now=lambda: 1000,
                                            client_factory=lambda *_: client)
            self.assertEqual(receipt['phase'], 'verified')
            self.assertEqual(receipt['project'], 'CustomOrg/PhotoStoryFork')
            request = client.submit.call_args.args[0]
            self.assertEqual((request['mode'], request['profile'], request['timeout_seconds']),
                             ('api', 'async-screen', 600))

    def test_each_regular_muse_stage_uses_its_business_schema_and_bound_result(self):
        from auto_review import FIELDS
        from process_batch import LANGUAGE_NAMES

        self.assertEqual(set(LANGUAGE_NAMES), set(qualification.qualification_contract(
            {'routes': {'labels': {'provider': 'muse', 'profile': 'labels'}}}, 'labels'
        )[1]['properties']['labels']['items']['properties']['translations']['properties']))
        outputs = {
            'screen': {'photos': [{'id': 'synthetic', 'decision': 'exclude', 'flags': [],
                                   'landscape': False, 'contentKind': 'uncertain', 'peopleRole': 'none',
                                   'compositionClear': False, 'aesthetic': 0, 'description': 'Blue block',
                                   'light': 'unknown', 'scene': 'unknown', 'place': {
                                       'city':'', 'landmark':'', 'evidence':'', 'confidence':'none'}}]},
            'group': {'drafts': []},
            'cross_review': {'checks': [{'draftId':'synthetic-draft', 'duplicateIds':[],
                                          'captionGrounded':True, 'locationGrounded':True, 'copy':{
                                              'title':'Sample', 'caption':'Color field', 'hashtags':'#color',
                                              'reason':'Calibration', 'photos':[{'id':'synthetic','alt':'Blue'}]}}]},
            'labels': {'labels': [{'id':'synthetic','translations': {
                lang: {'title':'Color sample','reason':'Generated image'} for lang in LANGUAGE_NAMES}}]},
            'strict_review': {field: field == 'needsHumanReview' for field in FIELDS},
            'publication': {field: field == 'needsHumanReview' for field in FIELDS},
        }
        env = self.env()
        binding = json.loads(env['PHOTOSTORY_NATIVE_BINDING'])
        for route in binding['routes'].values():
            route.update(provider='muse', model='synthetic-muse', worker='fixture-worker')
        env['PHOTOSTORY_NATIVE_BINDING'] = json.dumps(binding)
        for stage in sorted(STAGES):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, env, clear=True):
                client = Mock(resource='https://personal.acme.org')
                def record(request, key):
                    return {'id':'synthetic-task', 'owner':'Pigbibi/PhotoStory', 'provider':'muse',
                            'request':request, 'revision':1, 'status':'completed', 'created':990, 'updated':995,
                            'deadline':1590, 'worker':'fixture-worker', 'attempt':'attempt-1', 'output':outputs[stage]}
                client.submit.side_effect = record
                receipt = qualification.run(Path(tmp)/'stage', stage=stage, require_muse=True,
                                            now=lambda:1000, client_factory=lambda *_:client)
                self.assertTrue(receipt['adopted'])
                self.assertEqual(receipt['stage'], stage)
                request = client.submit.call_args.args[0]
                self.assertEqual((request['profile'], request['timeout_seconds']), (stage, 600))
                self.assertEqual(request['materials'][0]['stage'], stage)
                self.assertEqual(bool(request['materials'][0]['images']), stage != 'labels')
                client.get.return_value = record(request, None)
                verified = qualification.run(Path(tmp)/'read', stage=stage, task_id='synthetic-task',
                                             now=lambda:1000, client_factory=lambda *_:client)
                self.assertEqual(verified['phase'], 'completion_verified')
                client.submit.assert_called_once()
                client.get.assert_called_once_with('synthetic-task')

    def test_generic_api_gateway_qualifies_all_six_business_stages_and_readback(self):
        from auto_review import FIELDS
        from process_batch import LANGUAGE_NAMES

        outputs = {
            'screen': {'photos': [{'id': 'synthetic', 'decision': 'exclude', 'flags': [],
                                   'landscape': False, 'contentKind': 'uncertain', 'peopleRole': 'none',
                                   'compositionClear': False, 'aesthetic': 0, 'description': 'Blue block',
                                   'light': 'unknown', 'scene': 'unknown', 'place': {
                                       'city': '', 'landmark': '', 'evidence': '', 'confidence': 'none'}}]},
            'group': {'drafts': []},
            'cross_review': {'checks': [{'draftId': 'synthetic-draft', 'duplicateIds': [],
                                          'captionGrounded': True, 'locationGrounded': True, 'copy': {
                                              'title': 'Sample', 'caption': 'Color field', 'hashtags': '#color',
                                              'reason': 'Calibration', 'photos': [{'id': 'synthetic', 'alt': 'Blue'}]}}]},
            'labels': {'labels': [{'id': 'synthetic', 'translations': {
                lang: {'title': 'Color sample', 'reason': 'Generated image'} for lang in LANGUAGE_NAMES}}]},
            'strict_review': {field: field == 'needsHumanReview' for field in FIELDS},
            'publication': {field: field == 'needsHumanReview' for field in FIELDS},
        }
        binding = {
            'enabled': True, 'project': 'CustomOrg/PhotoStoryFork',
            'service_url': 'https://gateway.acme.org', 'audience': 'https://gateway.acme.org/mcp',
            'adoption_age_seconds': 3600,
            'routes': {s: {'mode': 'api', 'provider': 'openai-gateway', 'profile': s,
                           'model': 'gpt-4.1-mini', 'worker': 'api-worker'} for s in STAGES},
        }
        env = {
            'GITHUB_REPOSITORY': 'CustomOrg/PhotoStoryFork',
            'GITHUB_REF': 'refs/heads/main',
            'GITHUB_WORKFLOW_REF': 'CustomOrg/PhotoStoryFork/.github/workflows/processor.yml@refs/heads/main',
            'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'GITHUB_RUN_ATTEMPT': '1',
            'GITHUB_RUN_ID': '12345',
            'PHOTOSTORY_NATIVE_BINDING': json.dumps(binding),
        }
        for stage in sorted(STAGES):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp:
                client = Mock(resource='https://gateway.acme.org')

                def record(request, _key, current_stage=stage):
                    return {'id': 'task_generic_1', 'owner': 'CustomOrg/PhotoStoryFork',
                            'provider': 'openai-gateway', 'request': request, 'revision': 1,
                            'status': 'completed', 'created': 990, 'updated': 995, 'deadline': 1050,
                            'worker': 'api-worker', 'attempt': 'attempt-1', 'output': outputs[current_stage]}

                client.submit.side_effect = record
                with patch.dict(os.environ, env, clear=True):
                    receipt = qualification.run(Path(tmp) / 'stage', stage=stage, business_stage=True,
                                                now=lambda: 1000, client_factory=lambda *_: client)
                    self.assertEqual(receipt['phase'], 'verified')
                    self.assertEqual(receipt['provider'], 'openai-gateway')
                    request = client.submit.call_args.args[0]
                    self.assertEqual((request['mode'], request['profile'], request['timeout_seconds']),
                                     ('api', stage, 60))
                    client.get.return_value = record(request, None)
                    verified = qualification.run(Path(tmp) / 'read', stage=stage, task_id='task_generic_1',
                                                 now=lambda: 1000, client_factory=lambda *_: client)
                    self.assertEqual(verified['phase'], 'completion_verified')

        with tempfile.TemporaryDirectory() as tmp:
            event = Path(tmp) / 'event.json'
            event.write_text(json.dumps({'inputs': {'qualification_stage': 'all'}}))
            out = io.StringIO()
            with patch.dict(os.environ, {'GITHUB_EVENT_PATH': str(event), 'QUALIFICATION_STAGE': 'group'}, clear=True), \
                 patch.object(sys, 'argv', ['qualify', '--state', str(Path(tmp) / 'state')]), \
                 patch.object(qualification, 'run', return_value={'phase': 'verified', 'stage': 'group'}) as mock_run, \
                 redirect_stdout(out):
                self.assertEqual(qualification.main(), 0)
            self.assertTrue(mock_run.call_args.kwargs['business_stage'])

    def env(self):
        binding={'enabled':True,'project':'Pigbibi/PhotoStory','service_url':'https://personal.acme.org',
                 'audience':'https://personal.acme.org/mcp','adoption_age_seconds':3600,
                 'routes':{s:{'mode':'agent','provider':'dot','profile':s,'model':'gpt-6-sol',
                              'worker':'private-cloud-worker'} for s in STAGES}}
        return {'GITHUB_REPOSITORY':'Pigbibi/PhotoStory','GITHUB_REF':'refs/heads/main',
                'GITHUB_WORKFLOW_REF':'Pigbibi/PhotoStory/.github/workflows/processor.yml@refs/heads/main',
                'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'12345',
                'PHOTOSTORY_NATIVE_BINDING':json.dumps(binding)}

    def test_unclaimed_expiry_retains_diagnostics_without_resubmission(self):
        for service_expired in (False, True):
            with self.subTest(service_expired=service_expired), tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,self.env(),clear=True):
                clock=[1000]
                client=Mock(resource='https://personal.acme.org')
                def submit(request,key):
                    return {'id':'original-task','owner':'Pigbibi/PhotoStory','provider':'dot',
                            'request':request,'revision':1,'status':'queued',
                            'created':1000,'updated':1000,'deadline':1060}
                client.submit.side_effect=submit
                def get(task):
                    record=submit(client.submit.call_args.args[0],'unused')
                    if service_expired and clock[0]>=1060:
                        record.update(status='cancelled',error='deadline_before_submission')
                    return record
                client.get.side_effect=get
                def sleep(seconds):clock[0]+=seconds
                root=Path(tmp)/'qualification'
                with self.assertRaises(NativeStopped) as stopped:
                    qualification.run(root,now=lambda:clock[0],sleep=sleep,client_factory=lambda *_:client)
                receipt=json.loads((root/'receipt.json').read_text())
                self.assertEqual(receipt['failure_reason'],'task_expired_before_claim')
                self.assertEqual(receipt['task_status'],'cancelled' if service_expired else 'queued')
                self.assertFalse(receipt['worker_claim_present'])
                self.assertFalse(receipt['adopted'])
                self.assertEqual(receipt['task_id'],'original-task')
                client.submit.assert_called_once()
                self.assertTrue(all(c.args==('original-task',) for c in client.get.call_args_list))
                self.assertEqual(client.submit.call_args.args[0]['timeout_seconds'],60)
                summary=stopped.exception.summary
                self.assertNotIn('original-task',json.dumps(summary))
                self.assertEqual(summary['failure_reason'],'task_expired_before_claim')

    def test_main_reports_only_sanitized_failure_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            event=Path(tmp)/'event.json';event.write_text('{"inputs":{}}')
            private='https://private.invalid/task/private-id?token=not-a-real-secret'
            receipt={'phase':'unverified','task_id':private,'service_error_code':private,
                     'task_status':'failed','failure_reason':'task_failed',
                     'adopted':False,'worker_claim_present':False}
            error=qualification.QualificationUnverified(receipt)
            output=io.StringIO()
            with patch.dict(os.environ,{'GITHUB_EVENT_PATH':str(event)}), \
                 patch.object(sys,'argv',['qualify','--state',str(Path(tmp)/'state')]), \
                 patch.object(qualification,'run',side_effect=error), redirect_stdout(output):
                self.assertEqual(qualification.main(),1)
            summary=json.loads(output.getvalue())
            self.assertEqual(summary['task_status'],'failed')
            self.assertEqual(summary['failure_reason'],'task_failed')
            self.assertNotIn(private,output.getvalue())

    def test_failure_reason_distinguishes_claim_and_early_cancellation(self):
        for claimed in (False, True):
            value={'claim':['synthetic-worker','synthetic-attempt',1] if claimed else None,
                   'task_status':'running','task_deadline':1060}
            suffix='after_claim' if claimed else 'before_claim'
            self.assertEqual(qualification.failure_reason(value,1060),'task_expired_'+suffix)
            value['task_status']='cancelled'
            # Reading later cannot prove an earlier cancellation was a timeout.
            self.assertEqual(qualification.failure_reason(value,2000),'task_cancelled_'+suffix)

    def test_readback_reports_service_expiry_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,self.env(),clear=True):
            client=Mock(resource='https://personal.acme.org')
            def submit(request,key):
                return {'id':'synthetic-task','owner':'Pigbibi/PhotoStory','provider':'dot',
                        'request':request,'revision':1,'status':'queued','created':990,
                        'updated':990,'deadline':1050}
            client.submit.side_effect=submit
            with self.assertRaises(NativeStopped):
                qualification.run(Path(tmp)/'original',now=lambda:1000,sleep=lambda _:None,
                                  client_factory=lambda *_:client)
            record=submit(client.submit.call_args.args[0],'unused')
            record.update(status='cancelled',error='deadline_before_submission')
            client.reset_mock();client.get.return_value=record
            result=qualification.run(Path(tmp)/'readback',task_id='synthetic-task',
                                     now=lambda:2000,client_factory=lambda *_:client)
            self.assertEqual(result['failure_reason'],'task_expired_before_claim')
            self.assertEqual(result['service_error_code'],'deadline_before_submission')
            self.assertFalse(result['adopted']);self.assertTrue(result['read_only'])
            client.get.assert_called_once_with('synthetic-task')
            client.submit.assert_not_called();client.cancel.assert_not_called()

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

    def test_readback_uses_only_original_task_and_never_adopts_late_output(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ,self.env(),clear=True):
            client=Mock(resource='https://personal.acme.org')
            def submit(request,key):
                return {'id':'synthetic-task','owner':'Pigbibi/PhotoStory','provider':'dot','request':request,
                        'revision':1,'status':'completed','created':990,'updated':995,'deadline':1050,
                        'worker':'private-cloud-worker','attempt':'synthetic-attempt',
                        'output':{'kind':'synthetic-test'}}
            client.submit.side_effect=submit
            qualification.run(Path(tmp)/'original',now=lambda:1000,client_factory=lambda *_:client)
            request=client.submit.call_args.args[0]
            record=submit(request,'unused')
            client.reset_mock()
            client.get.return_value=record
            result=qualification.run(Path(tmp)/'readback',task_id='synthetic-task',now=lambda:2000,
                                     client_factory=lambda *_:client)
            self.assertEqual(result['phase'],'completion_verified')
            self.assertFalse(result['adopted']);self.assertTrue(result['read_only'])
            client.get.assert_called_once_with('synthetic-task')
            client.submit.assert_not_called();client.cancel.assert_not_called()
            for mutation in [{'provider':'grok'}, {'worker':'other-worker'},
                             {'request':dict(request,objective='private business task')},
                             {'updated':1051}, {'revision':2}, {'output':{'kind':'wrong'}}]:
                with self.subTest(mutation=mutation):
                    client.get.return_value={**record,**mutation}
                    with self.assertRaises(Exception):
                        qualification.run(Path(tmp)/('rejected-'+str(len(list(Path(tmp).iterdir())))),
                            task_id='synthetic-task',now=lambda:2000,client_factory=lambda *_:client)
            client.submit.assert_not_called();client.cancel.assert_not_called()
