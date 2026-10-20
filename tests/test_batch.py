import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('batch', Path(__file__).parents[1] / 'scripts/process_batch.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)



# This delegation interface is an injected offline fixture, not a serving API.
class _NativePersonalTransport:
    synthetic_only = True

    def __init__(self):
        import copy
        self.copy = copy.deepcopy
        self.records = {}
        self.calls = []
        self.output = {"checks": []}
        self.readback = lambda record: record
        self.lose_primary = False
        self.skip_helper = False
        self.auxiliary_output = None
        self.clock = [1000.0]

    @staticmethod
    def digest(value):
        import hashlib, json
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                             allow_nan=False, separators=(',', ':')).encode()).hexdigest()

    def record(self, request, role):
        record = {"id": "personal-native-" + role, "owner": "Pigbibi/PhotoStory",
                  "provider": "dot" if role == "primary" else "grok",
                  "worker": "photo-" + role, "attempt": "photo-attempt-" + role,
                  "revision": 1, "status": "completed",
                  "request_sha256": self.digest(request), "output": self.copy(self.output)}
        self.records[record["id"]] = record
        return record

    def submit_auxiliary(self, request, key):
        self.calls.append(("auxiliary", key, self.copy(request)))
        result = self.record(request, "auxiliary")
        if self.auxiliary_output is not None:
            result["output"] = self.copy(self.auxiliary_output)
        return self.readback(self.copy(result))

    def delegate_primary(self, request, key, *, auxiliary):
        self.calls.append(("primary", key, self.copy(request)))
        evidence = None if self.skip_helper else auxiliary()
        result = self.record(request, "primary")
        if evidence:
            result.update(auxiliary_task_id=evidence["task_id"],
                          auxiliary_output_sha256=evidence["output_sha256"])
        if self.lose_primary:
            raise TimeoutError("synthetic private primary result")
        return self.readback(self.copy(result))

    def get_task(self, task_id):
        self.calls.append(("get", task_id))
        return self.readback(self.copy(self.records[task_id]))


def _native_personal_context(root):
    root = root.resolve()
    transport = _NativePersonalTransport()
    state = root / "personal-state"
    state.mkdir(mode=0o700)
    return {
        "synthetic_only": True, "project": "Pigbibi/PhotoStory",
        "operation_id": "photostory-synthetic:batch-1",
        "roles": {role: {"provider": provider, "worker": "photo-" + role,
                         "model": "synthetic-photo", "profile": "photo-" + role}
                  for role, provider in (("primary", "dot"), ("auxiliary", "grok"))},
        "transport": transport, "fixture_root": root.resolve(), "state_root": state,
        "deadline": 1060.0, "now": lambda: transport.clock[0],
    }, transport


class NativeReviewTests(unittest.TestCase):
    def fixture(self):
        import tempfile
        from PIL import Image
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        Image.new("RGB", (100, 80), "blue").save(self.root / "p.jpg")
        self.context, self.transport = _native_personal_context(self.root)
        return b.native_review_gateway(self.context, stage="cross_review")

    def invoke(self, callback):
        return callback("synthetic untrusted draft", [{"id": "p"}],
                        [self.root / "p.jpg"], {"type": "object"}, self.root)

    def test_primary_delegates_one_independent_helper_then_reads_original_output(self):
        callback = self.fixture()
        self.assertEqual(self.invoke(callback), {"checks": []})
        self.assertEqual([c[0] for c in self.transport.calls], ["primary", "auxiliary"])
        records = self.transport.records
        self.assertEqual(len(records), 2)
        self.assertEqual(len({r["worker"] for r in records.values()}), 2)
        self.assertEqual(len({r["attempt"] for r in records.values()}), 2)
        self.assertEqual(len({r["request_sha256"] for r in records.values()}), 2)
        self.assertEqual(self.invoke(callback), {"checks": []})
        self.assertEqual(len([c for c in self.transport.calls if c[0] != "get"]), 2)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600
                            for p in self.context["state_root"].iterdir()))

    def test_wrong_identity_revision_or_request_and_missing_helper_never_adopt(self):
        for field, value in (("owner", "QuantStrategyLab/QuantAIService"),
                             ("provider", "other"), ("worker", "other"),
                             ("revision", 2), ("revision", True), ("attempt", ""),
                             ("request_sha256", "0"*64), ("status", "cancel_requested")):
            with self.subTest(field=field, value=value):
                callback = self.fixture()
                self.transport.readback = lambda record, k=field, v=value: {**record, k: v}
                with self.assertRaises(b.Stop):
                    self.invoke(callback)
                calls = list(self.transport.calls)
                with self.assertRaises(b.Stop):
                    self.invoke(callback)
                self.assertEqual(self.transport.calls, calls)
        callback = self.fixture()
        self.transport.skip_helper = True
        with self.assertRaises(b.Stop):
            self.invoke(callback)

    def test_unknown_timeout_reentry_is_zero_new_submissions(self):
        callback = self.fixture()
        self.transport.lose_primary = True
        with self.assertRaises(b.Stop):
            self.invoke(callback)
        calls = list(self.transport.calls)
        callback = b.native_review_gateway(dict(self.context), stage="cross_review")
        with self.assertRaises(b.Stop):
            self.invoke(callback)
        self.assertEqual(self.transport.calls, calls)

    def test_expiry_and_image_or_schema_drift_do_not_create_another_operation(self):
        callback = self.fixture()
        self.transport.lose_primary = True
        with self.assertRaises(b.Stop):
            self.invoke(callback)
        calls = list(self.transport.calls)
        self.transport.clock[0] = 1061
        with self.assertRaises(b.Stop):
            self.invoke(callback)
        self.assertEqual(self.transport.calls, calls)
        callback = self.fixture()
        self.invoke(callback)
        calls = list(self.transport.calls)
        from PIL import Image
        Image.new("RGB", (100, 80), "red").save(self.root / "p.jpg")
        with self.assertRaises(b.Stop):
            self.invoke(callback)
        self.assertEqual(self.transport.calls, calls)

    def test_helper_disagreement_or_omission_cannot_become_primary_approval(self):
        callback = self.fixture()
        self.transport.auxiliary_output = {"checks": [{"captionGrounded": False}]}
        with self.assertRaises(b.Stop):
            self.invoke(callback)


    def test_original_primary_attempt_and_helper_evidence_are_bound_on_resume(self):
        callback = self.fixture()
        self.invoke(callback)
        before = len([c for c in self.transport.calls if c[0] != "get"])
        self.transport.readback = lambda record: (
            {**record, "attempt": "replacement-primary"} if record["provider"] == "dot" else record)
        with self.assertRaises(b.Stop):
            self.invoke(callback)
        self.assertEqual(len([c for c in self.transport.calls if c[0] != "get"]), before)
        callback = self.fixture()
        original = self.transport.delegate_primary
        def bad_reference(*args, **kwargs):
            return {**original(*args, **kwargs), "auxiliary_output_sha256": "0" * 64}
        self.transport.delegate_primary = bad_reference
        with self.assertRaises(b.Stop):
            self.invoke(callback)

    def test_strict_review_native_result_and_failure_keep_original_manual_gate(self):
        from auto_review import review_drafts, FIELDS
        self.fixture()
        self.transport.output = {k: k != "needsHumanReview" for k in FIELDS}
        callback = b.native_review_gateway(self.context, stage="strict_review")
        draft = {"id": "d", "title": "Coast", "caption": "A coast.", "hashtags": "#Coast",
                 "photos": [{"id": "p", "alt": "Coast"}]}
        screen = {"id": "p", "decision": "allow", "flags": [], "landscape": True, "aesthetic": 9}
        source = {"reviewMode": "strict_auto", "strictAutoEnabled": True}
        result = review_drafts([draft], [screen], source, self.root, callback)
        self.assertEqual(result[0]["policy"], "strict-v2")
        self.assertEqual(result[0]["reviewedPost"]["caption"], "A coast.")
        self.assertEqual(list(self.root.glob("review-*")), [])
        calls = list(self.transport.calls)
        self.assertEqual(review_drafts([draft], [screen], {}, self.root, callback), [])
        self.assertEqual(self.transport.calls, calls)
        self.transport.readback = lambda record: {**record, "status": "cancel_requested"}
        self.assertEqual(review_drafts([draft], [screen], source, self.root, callback), [])
        self.assertEqual(list(self.root.glob("review-*")), [])

    def test_unbound_path_is_rejected_before_reading_image_bytes(self):
        from unittest.mock import patch
        callback = self.fixture()
        with patch.object(Path, "read_bytes", side_effect=AssertionError("unbound image read")):
            with self.assertRaises(b.Stop):
                callback("synthetic", [{"id": "p"}], [Path("/unbound/p.jpg")],
                         {"type": "object"}, self.root)
        self.assertEqual(self.transport.calls, [])


    def test_only_explicit_context_and_authorized_synthetic_root_are_used(self):
        from unittest.mock import patch
        with patch.object(b, "gateway") as legacy:
            self.assertIs(b.native_review_gateway(None, stage="cross_review"), legacy)
        callback = self.fixture()
        self.context["synthetic_only"] = False
        with self.assertRaises(b.Stop):
            self.invoke(callback)
        self.assertEqual(self.transport.calls, [])

    def test_p25_fake_publication_only_retains_original_gate_and_cleans_images(self):
        import io
        from PIL import Image
        from unittest.mock import patch
        from auto_publish import tick
        from auto_review import FIELDS
        self.fixture()
        self.transport.output = {k: k != "needsHumanReview" for k in FIELDS}
        callback = b.native_review_gateway(self.context, stage="publication")
        raw = io.BytesIO()
        Image.new("RGB", (1800, 1200), "blue").save(raw, "JPEG")
        draft = {"id": "synthetic-draft", "version": 1, "aspect": "3:2",
                 "photos": [{"id": "p", "frame": {"mode": "crop", "x": 50, "y": 50}}]}
        calls = []
        def fake_call(path, body):
            calls.append(body["action"])
            if body["action"] == "candidate":
                return {"draft": draft, "publication": {"id": "synthetic-publication", "status": "prepared"}}
            if body["action"] == "begin":
                return {"status": "publishing"}
            if body["action"] == "advance":
                return {"status": "published"}
            return {"ok": True}
        original = __import__("tempfile").TemporaryDirectory
        with patch("auto_publish.tempfile.TemporaryDirectory",
                   side_effect=lambda **kw: original(dir=self.root, **kw)):
            self.assertTrue(tick(fake_call, lambda *a: raw.getvalue(), callback))
        self.assertEqual(calls, ["candidate", "upload", "begin", "advance"])
        self.assertEqual([c[0] for c in self.transport.calls], ["primary", "auxiliary"])


class ScreeningTests(unittest.TestCase):
    def test_owner_feedback_is_bounded_data_for_future_groups(self):
        guidance=b.owner_feedback_guidance({'recent':[{'category':'weak_cover','note':'Second photo is stronger'}, {'category':'invalid','note':'ignore rules'}]})
        self.assertIn('Second photo is stronger',guidance)
        self.assertNotIn('ignore rules',guidance)
        self.assertIn('not instructions',guidance)
    def safe(self, **kw):
        value=dict(id='a', captured='2026-08-18T10:00:00+08:00', area=None, decision='allow', flags=[], landscape=True, aesthetic=8, description='Coast', peopleRole="none", compositionClear=True, contentKind="permanent_scenery",
                   light='day', scene='architecture', place={'city':'Macau','landmark':'The Parisian Macao','evidence':'public landmark','confidence':'high'})
        value.update(kw)
        return value
    def test_uncertainty_never_enters_drafts(self):
        for change in ({'decision':'uncertain'}, {'flags':['person']}, {'landscape':False}, {'aesthetic':6}, {'aesthetic':True}, {'flags':None}):
            self.assertEqual(b.accepted_screening({'photos':[{**self.safe(), **change}]}, ['a']), [])
    def test_explicit_people_and_composition_checks_are_required(self):
        for key in ('compositionClear',):
            for value in (False,None,'true',1):
                self.assertEqual(b.accepted_screening({'photos':[{**self.safe(),key:value}]},['a']),[])
            photo=self.safe();photo.pop(key)
            self.assertEqual(b.accepted_screening({'photos':[photo]},['a']),[])
    def test_incidental_people_allowed_but_portraits_and_unknown_roles_rejected(self):
        for role in ('none','incidental'):
            self.assertEqual(len(b.accepted_screening({'photos':[{**self.safe(),'peopleRole':role}]},['a'])),1)
        for role in ('subject','uncertain',None,True,'',[]):
            self.assertEqual(b.accepted_screening({'photos':[{**self.safe(),'peopleRole':role}]},['a']),[])
        photo=self.safe();photo.pop('peopleRole')
        self.assertEqual(b.accepted_screening({'photos':[photo]},['a']),[])
    def test_missing_or_unknown_ids_fail(self):
        for photos in ([], [self.safe(),self.safe()], [{**self.safe(),'id':'b'}]):
            with self.assertRaises(b.Stop): b.accepted_screening({'photos':photos},['a'])
    def test_only_explicit_safe_photo_passes(self):
        self.assertEqual(len(b.accepted_screening({'photos':[self.safe()]},['a'])),1)
    def test_scene_facts_are_bounded_and_required(self):
        for change in ({'light':'nighttime'}, {'light':None}, {'scene':'mixed'}, {'place':None},
                       {'place':{'city':'Macau','landmark':'The Parisian Macao','evidence':'public landmark','confidence':'medium'}},
                       {'place':{'city':'Macau','landmark':'x'*161,'evidence':'public landmark','confidence':'high'}}):
            self.assertEqual(b.accepted_screening({'photos':[{**self.safe(),**change}]},['a']),[])
    def test_different_scenes_are_split_before_caption_generation(self):
        groups=b.scene_groups([self.safe(id='horse',scene='wildlife'),self.safe(id='yurt',scene='culture'),self.safe(id='field',scene='wildlife')])
        self.assertEqual([[p['id'] for p in group] for group in groups],[['horse','field'],['yurt']])
    def test_events_and_missing_content_classification_are_not_admitted(self):
        for kind in ('temporary_event', 'uncertain', None, '', True):
            self.assertEqual(b.accepted_screening({'photos':[self.safe(contentKind=kind)]},['a']),[])
        photo=self.safe();photo.pop('contentKind')
        self.assertEqual(b.accepted_screening({'photos':[photo]},['a']),[])
    def test_same_scene_different_lights_and_landmarks_are_separate(self):
        photos=[self.safe(id='day'),self.safe(id='dusk',light='golden_hour'),
                self.safe(id='night',light='night'),self.safe(id='day-detail'),
                self.safe(id='other',place={'city':'Macau','landmark':'Senado Square','evidence':'sign','confidence':'high'})]
        self.assertEqual([[p['id'] for p in g] for g in b.scene_groups(photos)],
                         [['day','day-detail'],['dusk'],['night'],['other']])
    def test_unknown_place_or_light_never_merges_by_generic_scene(self):
        for change in ({'light':'unknown'}, {'scene':'unknown'},
                       {'place':{'city':'','landmark':'','evidence':'','confidence':'none'}},
                       {'place':{'city':'Hong Kong','landmark':'','evidence':'city skyline','confidence':'high'}}):
            self.assertEqual(len(b.scene_groups([self.safe(id='a',**change),self.safe(id='b',**change)])),2)
    def test_capture_time_and_location_can_veto_same_visual_site(self):
        photos=[self.safe(id='a',area=[22.3,114.2]),
                self.safe(id='near',captured='2026-08-18T03:00:00+00:00',area=[22.3,114.2]),
                self.safe(id='other-area',area=[22.4,114.1]),
                self.safe(id='later',captured='2026-08-18T16:00:00+08:00'),
                self.safe(id='next-day',captured='2026-08-19T10:00:00+08:00')]
        self.assertEqual([[p['id'] for p in g] for g in b.scene_groups(photos)],
                         [['a','near'],['other-area'],['later'],['next-day']])
    def test_missing_or_unzoned_capture_time_stays_single(self):
        for captured in (None,'invalid','2026-08-18T10:00:00'):
            self.assertEqual(len(b.scene_groups([self.safe(id='a',captured=captured),self.safe(id='b',captured=captured)])),2)
    def test_time_window_does_not_chain_into_an_all_day_group(self):
        photos=[self.safe(id=str(hour),captured=f'2026-08-18T{hour:02}:00:00+08:00') for hour in (10,12,14)]
        self.assertEqual([[p['id'] for p in g] for g in b.scene_groups(photos)],[['10','12'],['14']])
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
    def test_service_gateway_receives_only_oidc_transport_not_processor_credentials(self):
        from unittest.mock import patch
        with patch.dict(b.os.environ, {
            "PATH": "/usr/bin", "HOME": "/restricted-home", "CODEX_GATEWAY_BACKEND": "service",
            "CODEX_GATEWAY_SERVICE_URL": "https://gateway.example",
            "CODEX_GATEWAY_SERVICE_MODEL": "gpt-6-sol",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://github.example/oidc",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "transport-token",
            "PHOTOSTORY_BATCH_TOKEN": "private-machine-token",
            "GH_TOKEN": "private-gh-token",
        }, clear=True):
            env = b.gateway_environment()
        self.assertEqual(env['CODEX_GATEWAY_BACKEND'], 'service')
        self.assertEqual(env['CODEX_GATEWAY_SERVICE_MODEL'], 'gpt-6-sol')
        self.assertEqual(env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'], 'transport-token')
        self.assertNotIn('PHOTOSTORY_BATCH_TOKEN', env)
        self.assertNotIn('GH_TOKEN', env)
    def test_graph_pagination_cannot_exfiltrate_token(self):
        with self.assertRaises(b.Stop): b.graph('https://evil.invalid/next','secret')


class FailureReportingTests(unittest.TestCase):
    def test_only_fixed_failure_reasons_are_reported(self):
        self.assertEqual(b.failure_reason(b.Stop('photo_limit')), 'photo_limit')
        self.assertEqual(b.failure_reason(ValueError('folder_not_found')), 'folder_not_found')
        self.assertEqual(b.failure_reason(b.Stop('provider secret response')), 'unknown')
        self.assertEqual(b.failure_reason(RuntimeError('provider secret response')), 'unknown')

    def test_only_fixed_failure_stages_are_reported(self):
        for stage in ('inventory', 'thumbnail', 'ai_gateway', 'completion'):
            self.assertEqual(b.failure_stage(stage), stage)
        self.assertEqual(b.failure_stage('provider secret stage'), 'inventory')


class CandidateTests(unittest.TestCase):
    def test_all_and_custom_scope_use_capture_time_and_only_coarse_location(self):
        item={'id':'one','parentReference':{'driveId':'drive'},'image':{},'photo':{'takenDateTime':'2026-08-26T18:00:00Z'},'location':{'latitude':13.756331,'longitude':100.501762},'eTag':'v1'}
        all_source={'start':None,'end':None}
        self.assertEqual(b.candidate(item,all_source)['area'],[13.8,100.5])
        self.assertIsNone(b.candidate(item,{'start':'2026-08-16','end':'2026-08-27'})) # 02:00 on Aug 27 in Shanghai.
        self.assertIsNone(b.candidate({**item,'photo':{}},all_source))
        self.assertIsNone(b.candidate({**item,'name':'Screenshot.png'},all_source))

class ThumbnailOriginTests(unittest.TestCase):
    def test_microsoft_regional_thumbnail_service(self):
        for host in ('japaneast1-mediap.svc.ms','eastus1-mediap.svc.ms','sample.files.1drv.com'):
            self.assertTrue(b.valid_thumbnail_url('https://'+host+'/transform/thumbnail?test=1'))
    def test_untrusted_or_ambiguous_origins_are_rejected(self):
        for url in ('https://japaneast1-mediap.svc.ms.evil.invalid/image',
                    'https://evil-svc.ms/image','https://unrelated.svc.ms/image',
                    'http://japaneast1-mediap.svc.ms/image',
                    'https://japaneast1-mediap.svc.ms:8080/image',
                    'https://name@japaneast1-mediap.svc.ms/image'):
            self.assertFalse(b.valid_thumbnail_url(url))

if __name__=='__main__': unittest.main()

class CompositionTests(unittest.TestCase):
    def draft(self, ids):
        return {'title':'Coast','caption':'Coast.','hashtags':'#Coast','reason':'Theme',
                'photos':[{'id':i,'alt':'Coast','frame':{'mode':'crop','x':50,'y':20}} for i in ids]}
    def test_mixed_orientation_is_rejected(self):
        with self.assertRaises(b.Stop):
            b.validated_groups({'drafts':[self.draft(['a','b'])]}, {'a','b'}, 'job', {'a':(800,600),'b':(600,800)})
    def test_orientation_sets_ratio_and_retains_crop_position(self):
        for size,aspect in [((800,600),'3:2'),((600,800),'4:5'),((600,600),'1:1')]:
            d=b.validated_groups({'drafts':[self.draft(['a'])]}, {'a'}, 'job', {'a':size})[0]
            self.assertEqual(d['aspect'],aspect)
            self.assertEqual(d['photos'][0]['frame'],{'mode':'crop','x':50,'y':20})
    def test_missing_or_invalid_crop_is_rejected(self):
        for frame in [None,{'mode':'fit','x':50,'y':50},{'mode':'crop','x':101,'y':50}]:
            d=self.draft(['a']);d['photos'][0]['frame']=frame
            with self.assertRaises(b.Stop):
                b.validated_groups({'drafts':[d]}, {'a'}, 'job', {'a':(800,600)})
