"""Single-handler PhotoStory tasks: real local runtime, generated pixels, no network."""
import base64
import hashlib
import io
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import process_batch as batch
from ai_service.client import TaskClient
from ai_service.runtime import Policy, TaskRuntime
from ai_service.transport import HttpReply


class Trigger:
    mode = 'agent'
    callback_driven = True
    def __init__(self):
        self.submissions = 0
        self.cancellations = 0
    def submit(self, request, **identity):
        self.submissions += 1
        return {'synthetic': True}
    def cancel(self, handle):
        self.cancellations += 1
        return None


class LocalTransport:
    def __init__(self, root, routes):
        import time
        self.clock = [time.time()]
        self.routes = routes
        self.project = 'Pigbibi/PhotoStory'
        self.runtime = TaskRuntime(root/'service.sqlite', {'dot': Trigger(), 'grok': Trigger()}, {
            self.project: Policy({'agent:'+s: r['provider'] for s, r in routes.items()},
                                 {'dot': {'synthetic-photo'}, 'grok': {'synthetic-photo'}})})
        self.calls = []
        self.complete = True
        self.dispatch = True
        self.lose = False
        self.output = lambda request: {'ok': True}
        self.mutate = lambda record: record

    def request(self, url, *, method, headers, body):
        from urllib.parse import urlsplit
        path = urlsplit(url).path
        assert headers['Authorization'] == 'Bearer synthetic-photo'
        self.calls.append((method, path, headers.get('Idempotency-Key')))
        if method == 'POST' and path == '/v1/tasks':
            request = json.loads(body)
            record = self.runtime.submit(self.project, headers['Idempotency-Key'], request)
            route = self.routes[request['profile']]
            if self.dispatch:
                self.runtime.tick()
                record = self.runtime.claim(self.project, record['id'], route['provider'], route['worker'], 'attempt-'+record['id'])
            if self.dispatch and self.complete:
                self.runtime.report(self.project, record['id'], route['provider'], record['worker'], record['attempt'], record['revision'], 'completed', self.output(request))
            record = self.runtime.get(self.project, record['id'])
            if self.lose:
                raise TimeoutError('synthetic response lost after commit')
        elif path.endswith('/cancel'):
            record = self.runtime.cancel(self.project, path.split('/')[-2])
        else:
            record = self.runtime.get(self.project, path.rsplit('/', 1)[-1])
        return HttpReply(200, json.dumps(self.mutate(record)).encode())


STAGES = ('screen', 'group', 'cross_review', 'labels', 'strict_review', 'publication')
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['ok'], 'properties': {'ok': {'const': True}}}


def context(root):
    routes = {stage: {'mode': 'agent', 'provider': 'grok' if stage == 'cross_review' else 'dot',
                     'profile': stage, 'model': 'synthetic-photo', 'worker': 'photo-'+stage} for stage in STAGES}
    state = root/'state'
    state.mkdir(mode=0o700)
    transport = LocalTransport(root, routes)
    return {'synthetic_only': True, 'project': transport.project, 'operation_id': 'photo-synthetic-job-batch',
            'client': TaskClient('https://personal.invalid', 'synthetic-photo', transport=transport),
            'routes': routes, 'fixture_root': root.resolve(), 'state_root': state.resolve(),
            'now': lambda: transport.clock[0], 'deadline': transport.clock[0]+60,
            'persist': lambda: None}, transport


def photo(root, size=(80, 60)):
    path = root/'p.jpg'
    Image.new('RGB', size, 'blue').save(path, 'JPEG')
    return path


def test_six_existing_stages_each_create_exactly_one_configured_task(tmp_path):
    ctx, wire = context(tmp_path)
    image = photo(tmp_path)
    for stage in STAGES:
        assert batch.native_review_gateway(ctx, stage=stage)('untrusted prompt', [{'id': 'p'}], [] if stage == 'labels' else [image], SCHEMA, tmp_path) == {'ok': True}
    assert sum(m == 'POST' and p == '/v1/tasks' for m, p, _ in wire.calls) == 6
    with wire.runtime.connection() as db:
        records = [wire.runtime.get(wire.project, row[0]) for row in db.execute('SELECT id FROM tasks')]
    assert {r['request']['profile'] for r in records} == set(STAGES)
    assert all(r['provider'] == ctx['routes'][r['request']['profile']]['provider'] for r in records)
    assert all('helper' not in r['request']['objective'].lower() for r in records)


def test_sqlite_identity_restores_through_existing_cloud_snapshot_without_new_submit(tmp_path):
    import cloud_inventory
    from native_tasks import NativePending
    ctx, wire = context(tmp_path)
    image = photo(tmp_path)
    wire.complete = False
    snapshots = []
    ctx['persist'] = lambda: snapshots.append(cloud_inventory.archive(ctx['state_root']))
    with pytest.raises(NativePending):
        batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id': 'p'}], [image], SCHEMA, tmp_path)
    restored = tmp_path/'restored'
    cloud_inventory.restore(restored, snapshots[-1])
    with wire.runtime.connection() as db:
        record = db.execute('SELECT id FROM tasks').fetchone()[0]
    current = wire.runtime.get(wire.project, record)
    wire.runtime.report(wire.project, record, current['provider'], current['worker'], current['attempt'], current['revision'], 'completed', {'ok': True})
    ctx = {**ctx, 'state_root': restored.resolve(), 'persist': lambda: None}
    assert batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id': 'p'}], [image], SCHEMA, tmp_path) == {'ok': True}
    assert sum(m == 'POST' and p == '/v1/tasks' for m, p, _ in wire.calls) == 1


def test_unknown_after_commit_restores_without_retry_or_poll(tmp_path):
    import cloud_inventory
    from native_tasks import NativeStopped
    ctx, wire = context(tmp_path)
    image = photo(tmp_path)
    snapshots = []
    ctx['persist'] = lambda: snapshots.append(cloud_inventory.archive(ctx['state_root']))
    wire.lose = True
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id': 'p'}], [image], SCHEMA, tmp_path)
    restored = tmp_path/'restored'
    cloud_inventory.restore(restored, snapshots[-1])
    ctx = {**ctx, 'state_root': restored.resolve(), 'persist': lambda: None}
    count = len(wire.calls)
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id': 'p'}], [image], SCHEMA, tmp_path)
    assert len(wire.calls) == count


@pytest.mark.parametrize('stop', ['cancel', 'expiry'])
def test_stop_cancels_original_task_once_and_never_reports_it_stopped_early(tmp_path, stop):
    from native_tasks import NativePending, NativeStopped
    ctx, wire = context(tmp_path)
    image = photo(tmp_path)
    wire.complete = False
    call = lambda: batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id': 'p'}], [image], SCHEMA, tmp_path)
    with pytest.raises(NativePending): call()
    if stop == 'cancel': ctx['cancel'] = True
    else: wire.clock[0] = ctx['deadline']+1
    for _ in range(2):
        with pytest.raises(NativeStopped): call()
    assert sum(p.endswith('/cancel') for _, p, _ in wire.calls) == 1
    with wire.runtime.connection() as db:
        task_id = db.execute('SELECT id FROM tasks').fetchone()[0]
    record = wire.runtime.get(wire.project, task_id)
    assert record['status'] == 'cancel_requested'
    wire.runtime.report(wire.project, task_id, record['provider'], record['worker'], record['attempt'], record['revision'], 'cancelled')
    assert wire.runtime.get(wire.project, task_id)['status'] == 'cancelled'


@pytest.mark.parametrize('field,value', [('owner','QuantStrategyLab/QuantAIService'), ('provider','wrong'), ('revision',True), ('worker','wrong-worker'), ('output',{'ok':False})])
def test_wrong_binding_or_schema_never_consumes_result(tmp_path, field, value):
    from native_tasks import NativeStopped
    ctx, wire = context(tmp_path)
    wire.mutate = lambda record: {**record, field:value}
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx, stage='labels')('prompt', [{'id':'p'}], [], SCHEMA, tmp_path)


def test_actual_processor_missing_binding_stops_before_business_or_gateway_io():
    with patch.object(batch,'request',side_effect=AssertionError('business I/O')), patch.object(batch,'gateway',side_effect=AssertionError('old gateway')):
        with pytest.raises(batch.Stop): batch.run()


@pytest.mark.parametrize('dispatched', [False, True])
def test_service_deadline_expiry_is_read_back_without_replacement_or_early_stop_claim(tmp_path, dispatched):
    from native_tasks import NativePending, NativeStopped
    ctx, wire = context(tmp_path)
    ctx['deadline'] += 600
    wire.complete, wire.dispatch = False, dispatched
    call = lambda: batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending): call()
    wire.clock[0] += 61
    with patch('ai_service.runtime.time.time',return_value=wire.clock[0]):
        wire.runtime.tick()
        wire.runtime.tick()
    with wire.runtime.connection() as db:
        task_id = db.execute('SELECT id FROM tasks').fetchone()[0]
    record = wire.runtime.get(wire.project,task_id)
    assert record['status'] == ('cancel_requested' if dispatched else 'cancelled')
    assert wire.runtime.providers['dot'].submissions == int(dispatched)
    assert wire.runtime.providers['dot'].cancellations == int(dispatched)
    with pytest.raises(NativeStopped): call()
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in wire.calls) == 1


def test_actual_processor_five_stages_and_final_publication_consume_six_single_tasks(tmp_path):
    from auto_review import FIELDS
    import auto_publish
    from cross_review import SCHEMA as CROSS_SCHEMA
    from translate_labels import SCHEMA as LABEL_SCHEMA
    ctx, wire = context(tmp_path)
    image = photo(tmp_path, (1800,1200)).read_bytes()
    p = {'id':'p','captured':'2026-08-18T10:00:00+08:00','taken':1000,'area':None}
    safe = {'id':'p', 'decision':'allow','flags':[],'landscape':True,'aesthetic':9,
            'description':'Coast','peopleRole':'none','compositionClear':True,'contentKind':'permanent_scenery',
            'light':'day','scene':'architecture','place':{'city':'','landmark':'','evidence':'','confidence':'none'}}
    saved = []
    def output(request):
        stage = request['materials'][0]['stage']
        if stage == 'screen': return {'photos':[safe]}
        if stage == 'group': return {'drafts':[{'title':'Coast','caption':'A coast.','hashtags':'#Coast','reason':'Theme', 'photos':[{'id':'p','alt':'Coast','frame':{'mode':'crop','x':50,'y':50}}]}]}
        if stage == 'cross_review':
            drafts = json.loads(request['objective'].split('Post data:\n',1)[1])['drafts']
            return {'checks':[{'draftId':d['id'],'duplicateIds':[],'captionGrounded':True,'locationGrounded':True,
                              'copy':{**{k:d[k] for k in ('title','caption','hashtags','reason')},'photos':[{'id':'p','alt':'Coast'}]}} for d in drafts]}
        if stage == 'labels':
            return {'labels':[{'id':r['id'],'translations':{code:{'title':'Coast','reason':'Theme'} for code in batch.LANGUAGE_NAMES}} for r in request['materials'][0]['records']]}
        return {k:k != 'needsHumanReview' for k in FIELDS}
    wire.output = output
    inv = MagicMock()
    inv.scan.return_value = True
    inv.next_batch.return_value = [p]
    inv.stage_batch.return_value = 'batch'
    inv.known_digest.return_value = False
    inv.progress.return_value = {'phase':'processing','total':1,'processed':0,'analyzed':0,'batches':0}
    inv.proposed_progress.return_value = {'phase':'complete','total':1,'processed':1,'analyzed':1,'batches':1}
    def request(url, **kwargs):
        if url.endswith('/internal/autopublish'): result = None
        elif url.endswith('/internal/claim'): result = {'id':'job','lease':'synthetic-lease'}
        elif url.endswith('/internal/source'): result = {'pipeline':2,'progress':{'phase':'processing'},'maxPhotos':20,'draftLimit':1,'accessToken':'synthetic','reviewMode':'strict_auto','strictAutoEnabled':True}
        elif url.endswith('/internal/complete'):
            saved.append(kwargs['body']); result = {'count':len(saved[-1]['drafts'])}
        else: result = {}
        return json.dumps(result).encode()
    with patch.dict('os.environ', {'PHOTOSTORY_URL':'https://photo.invalid','PHOTOSTORY_BATCH_TOKEN':'synthetic','PHOTOSTORY_STATE_DIR':str(tmp_path/'inventory')}, clear=True), \
         patch('inventory.Inventory',return_value=inv), patch.object(batch,'request',side_effect=request), \
         patch.object(batch,'thumbnail',return_value=image), \
         patch('preselect.representatives',side_effect=lambda previews,*args:[(v,data,{}) for v,data in previews]), \
         patch.object(batch,'gateway',side_effect=AssertionError('retired gateway')):
        batch.run(native_context=ctx)
    assert len(saved) == 1 and len(saved[0]['drafts']) == 1
    assert len(saved[0]['crossReviews']) == 1 and len(saved[0]['autoReviews']) == 1
    draft = {**saved[0]['drafts'][0], 'version':1}
    actions = []
    def publication_call(path, body):
        actions.append(body)
        if body['action'] == 'candidate': return {'draft':draft,'publication':{'id':'publication','status':'prepared'}}
        return {}
    with patch.object(auto_publish,'finish_publication',return_value=True), patch.object(batch,'gateway',side_effect=AssertionError('retired gateway')):
        assert auto_publish.tick(publication_call, lambda *args:image,
            batch.native_review_gateway(ctx,stage='publication'),work_root=tmp_path) is True
    assert any(a['action'] == 'begin' and a['review']['needsHumanReview'] is False for a in actions)
    assert sum(m == 'POST' and p == '/v1/tasks' for m,p,_ in wire.calls) == 6
