"""Public caller contracts with a fake client; private SDK integration runs privately."""
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


class LocalTransport:
    """Controlled records for caller assertions, not a service/worker qualification."""
    resource = 'https://personal.invalid'
    def __init__(self, root, routes):
        import time
        self.clock = [time.time()]
        self.routes = routes
        self.project = 'Pigbibi/PhotoStory'
        self.records = {}
        self.calls = []
        self.complete = True
        self.dispatch = True
        self.lose = False
        self.output = lambda request: {'ok': True}
        self.mutate = lambda record: record

    def response(self, record):
        return self.mutate(json.loads(json.dumps(record)))

    def submit(self, request, key):
        self.calls.append(('POST', '/v1/tasks', key))
        route = self.routes[request['profile']]
        task = 'synthetic-task-'+str(len(self.records)+1)
        record = {'id':task, 'owner':self.project, 'request':json.loads(json.dumps(request)),
                  'provider':route['provider'], 'revision':1, 'deadline':self.clock[0]+60,
                  'created':self.clock[0], 'updated':self.clock[0],
                  'worker':route['worker'] if self.dispatch else None,
                  'attempt':'synthetic-attempt-'+task if self.dispatch else None,
                  'status':'running' if self.dispatch else 'queued'}
        if self.dispatch and self.complete:
            record.update(status='completed', output=self.output(request))
        self.records[task] = record
        if self.lose:
            raise TimeoutError('synthetic response lost after commit')
        return self.response(record)

    def get(self, task):
        self.calls.append(('GET', '/v1/tasks/'+task, None))
        return self.response(self.records[task])

    def cancel(self, task):
        self.calls.append(('POST', '/v1/tasks/'+task+'/cancel', None))
        self.records[task]['status'] = 'cancel_requested' if self.records[task]['worker'] else 'cancelled'
        return self.response(self.records[task])

    def complete_task(self, task):
        self.records[task].update(status='completed', output=self.output(self.records[task]['request']), updated=self.clock[0])

    def acknowledge_cancel(self, task):
        self.records[task]['status'] = 'cancelled'

    def expire(self):
        for record in self.records.values():
            if self.clock[0] >= record['deadline']:
                record['status'] = 'cancel_requested' if record['worker'] else 'cancelled'


STAGES = ('screen', 'group', 'cross_review', 'labels', 'strict_review', 'publication')
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['ok'], 'properties': {'ok': {'const': True}}}


def context(root):
    routes = {stage: {'mode': 'agent', 'provider': 'grok' if stage == 'cross_review' else 'dot',
                     'profile': stage, 'model': 'synthetic-photo', 'worker': 'photo-'+stage} for stage in STAGES}
    state = root/'state'
    state.mkdir(mode=0o700)
    transport = LocalTransport(root, routes)
    return {'synthetic_only': True, 'project': transport.project, 'operation_id': 'photo-synthetic-job-batch',
            'client': transport,
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
    records = list(wire.records.values())
    assert {r['request']['profile'] for r in records} == set(STAGES)
    assert all(r['provider'] == ctx['routes'][r['request']['profile']]['provider'] for r in records)
    assert all('helper' not in r['request']['objective'].lower() for r in records)


@pytest.mark.parametrize('phase', ['intent_checkpoint', 'response', 'adoption_checkpoint'])
def test_frozen_deadline_cannot_be_extended_by_context_mutation(tmp_path, phase):
    from native_tasks import NativeStopped
    ctx, wire = context(tmp_path)
    image = photo(tmp_path)
    original = ctx['deadline']

    def extend():
        ctx['deadline'] = original + 100
        wire.clock[0] = original + 1

    checkpoints = [0]
    def persist():
        checkpoints[0] += 1
        if (phase == 'intent_checkpoint' and checkpoints[0] == 1
                or phase == 'adoption_checkpoint' and checkpoints[0] == 2):
            extend()
    ctx['persist'] = persist
    if phase == 'response':
        def changed(record):
            extend()
            return record
        wire.mutate = changed
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id':'p'}], [image], SCHEMA, tmp_path)
    expected = 0 if phase == 'intent_checkpoint' else 1
    assert sum(m == 'POST' and p == '/v1/tasks' for m, p, _ in wire.calls) == expected
    count = len(wire.calls)
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id':'p'}], [image], SCHEMA, tmp_path)
    assert len(wire.calls) == count


def test_known_expired_running_task_is_read_once_then_cancels_original_once(tmp_path):
    from native_tasks import NativePending, NativeStopped
    ctx, wire = context(tmp_path)
    image = photo(tmp_path)
    wire.complete = False
    original = wire.clock[0] + 5
    wire.mutate = lambda record: {**record, 'deadline':original}
    with pytest.raises(NativePending):
        batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id':'p'}], [image], SCHEMA, tmp_path)
    wire.clock[0] = original + 1
    before = len(wire.calls)
    for _ in range(2):
        with pytest.raises(NativeStopped):
            batch.native_review_gateway(ctx, stage='screen')('prompt', [{'id':'p'}], [image], SCHEMA, tmp_path)
    after = wire.calls[before:]
    task_id=next(iter(wire.records))
    assert after == [('GET','/v1/tasks/'+task_id,None),('POST','/v1/tasks/'+task_id+'/cancel',None)]


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
    record = next(iter(wire.records))
    wire.complete_task(record)
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
    task_id = next(iter(wire.records))
    record = wire.records[task_id]
    assert record['status'] == 'cancel_requested'
    wire.acknowledge_cancel(task_id)
    assert wire.records[task_id]['status'] == 'cancelled'


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


def test_route_drift_at_checkpoint_stops_before_first_submission(tmp_path):
    from native_tasks import NativeStopped
    ctx, wire = context(tmp_path)
    ctx['persist'] = lambda: ctx['routes']['labels'].update(profile='changed-profile')
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    assert wire.calls == []


def test_unclaimed_revision_change_after_restore_is_rejected(tmp_path):
    from native_tasks import NativePending, NativeStopped
    ctx, wire = context(tmp_path)
    wire.dispatch = False
    call = lambda: batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending): call()
    wire.mutate = lambda record:{**record,'revision':record['revision']+1}
    with pytest.raises(NativeStopped): call()
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in wire.calls) == 1


@pytest.mark.parametrize('dispatched', [False, True])
def test_service_deadline_expiry_is_read_back_without_replacement_or_early_stop_claim(tmp_path, dispatched):
    from native_tasks import NativePending, NativeStopped
    ctx, wire = context(tmp_path)
    ctx['deadline'] += 600
    wire.complete, wire.dispatch = False, dispatched
    call = lambda: batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending): call()
    wire.clock[0] += 61
    wire.expire()
    task_id = next(iter(wire.records))
    record = wire.records[task_id]
    assert record['status'] == ('cancel_requested' if dispatched else 'cancelled')
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
    inv.get.return_value = None
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


def test_timely_completed_stage_reuses_private_receipt_without_expired_remote_read(tmp_path):
    ctx, wire = context(tmp_path)
    ctx['deadline'] += 600
    call = lambda: batch.native_review_gateway(ctx, stage='labels')('prompt', [{'id':'p'}], [], SCHEMA, tmp_path)
    assert call() == {'ok':True}
    before = len(wire.calls)
    wire.clock[0] += 61
    assert call() == {'ok':True}
    assert len(wire.calls) == before


@pytest.mark.parametrize('stop', ['deadline', 'cancel'])
def test_cached_receipt_rechecks_original_stop_after_schema_validation(tmp_path, stop):
    from native_tasks import Draft202012Validator, NativeStopped
    ctx, wire = context(tmp_path)
    call = lambda: batch.native_review_gateway(ctx, stage='labels')('prompt', [{'id':'p'}], [], SCHEMA, tmp_path)
    assert call() == {'ok':True}
    before = len(wire.calls)
    validate = Draft202012Validator.validate
    def validate_then_stop(validator, instance, *args, **kwargs):
        validate(validator, instance, *args, **kwargs)
        if stop == 'deadline':
            wire.clock[0] = ctx['deadline']
        else:
            ctx['cancel'] = True
    with patch.object(Draft202012Validator, 'validate', validate_then_stop):
        with pytest.raises(NativeStopped, match='native_cancel_or_expiry'):
            call()
    assert len(wire.calls) == before


def test_effective_request_limit_rejects_before_intent_or_submit(tmp_path):
    from native_tasks import NativeStopped
    ctx, wire = context(tmp_path)
    ctx['limits'] = {'request_bytes':100, 'response_bytes':2_000_000}
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx, stage='labels')('prompt', [{'id':'p'}], [], SCHEMA, tmp_path)
    assert wire.calls == []
    assert not (ctx['state_root']/'native.sqlite3').exists()


@pytest.mark.parametrize('checkpoint_failure', [None, 'before_commit', 'after_commit'])
def test_actual_batch_checkpoint_commits_inventory_ref_before_first_native_post(tmp_path, checkpoint_failure):
    import cloud_inventory
    import sqlite3
    ctx, wire = context(tmp_path)
    wire.complete = False
    directory = tmp_path/'inventory'
    stages, pointer, calls = {}, [], []
    from inventory import Inventory
    p = {'id':'p','captured':'2026-08-18T10:00:00+08:00','taken':1000,'area':None}
    source = {'pipeline':2,'progress':{},'maxPhotos':20,'draftLimit':1,'accessToken':'synthetic'}
    policy = hashlib.sha256((batch.SCREEN_PROMPT+batch.GROUP_PROMPT).encode()).hexdigest()
    inv = Inventory(directory,'job',source,policy)
    with inv.db:
        inv.set('initialized',True)
        inv.db.execute("INSERT INTO photos(id,body,taken,status) VALUES(?,?,?,?)",('p',json.dumps(p),1000,'pending'))
    source['progress'] = {**inv.progress(),'phase':'processing'}
    class Cloud:
        def __init__(self,*args): pass
        def require_seed(self): pass
        def load(self,*args): return False
        def save(self, root, job, lease, *args):
            assert Path(root) == directory and job == 'job' and lease == 'synthetic-lease'
            ref = '00000000-0000-4000-8000-'+str(len(stages)+1).zfill(12)
            stages[ref] = cloud_inventory.archive(root)
            return ref
    def request(url, **kwargs):
        path = url.removeprefix('https://photo.invalid'); body = kwargs.get('body')
        calls.append((path,body))
        if path == '/internal/autopublish': value = None
        elif path == '/internal/claim': value = {'id':'job','lease':'synthetic-lease'}
        elif path == '/internal/source': value = source
        elif path == '/internal/checkpoint':
            assert body['inventoryRef'] in stages
            if checkpoint_failure == 'before_commit':
                raise TimeoutError('synthetic checkpoint not committed')
            pointer[:] = [body['inventoryRef']]
            if checkpoint_failure == 'after_commit':
                raise TimeoutError('synthetic checkpoint reply lost')
            value = {'ok':True}
        else: value = {}
        return json.dumps(value).encode()
    original = wire.submit
    def submit(request_value,key):
        assert calls[-1][0] == '/internal/checkpoint' and calls[-1][1]['nativeCheckpoint'] is True
        restored = tmp_path/'inspect'
        cloud_inventory.restore(restored, stages[pointer[0]])
        with sqlite3.connect(restored/'native.sqlite3') as db:
            value = json.loads(db.execute('SELECT value FROM native_operations').fetchone()[0])
        assert value['intent'] is True and value['task_id'] is None
        return original(request_value,key)
    wire.submit = submit
    with patch.dict('os.environ', {'PHOTOSTORY_URL':'https://photo.invalid','PHOTOSTORY_BATCH_TOKEN':'synthetic',
             'PHOTOSTORY_STATE_DIR':str(directory),'PHOTOSTORY_STATE_BACKEND':'cloudflare'},clear=True), \
         patch('cloud_inventory.CloudInventory',Cloud), patch('inventory.Inventory',return_value=inv), \
         patch.object(batch,'request',side_effect=request), patch.object(batch,'thumbnail',return_value=photo(tmp_path).read_bytes()), \
         patch('preselect.representatives',side_effect=lambda previews,*args:[(v,data,{}) for v,data in previews]):
        if checkpoint_failure:
            with pytest.raises(batch.Stop):
                batch.run(native_context=ctx)
        else:
            batch.run(native_context=ctx)
    if checkpoint_failure:
        assert wire.calls == []
        # A lost acknowledgement never permits the next task POST. If the
        # pointer committed, its snapshot retains the uncertain intent.
        assert bool(pointer) == (checkpoint_failure == 'after_commit')
        assert any(path == '/internal/fail' for path,_ in calls)
        return
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in wire.calls) == 1
    assert (directory/'native.sqlite3').exists()
    assert calls[-1][0] == '/internal/checkpoint' and 'nativeCheckpoint' not in calls[-1][1]
    assert not any(path in {'/internal/fail','/internal/complete'} for path,_ in calls)


def test_operation_entry_restores_original_deadline_and_identity(tmp_path):
    from native_tasks import NativePending, operation_context
    ctx, wire = context(tmp_path)
    bound = batch._native_business_context(ctx,'batch',{'job_id':'job','batch_id':'batch'})
    wire.complete = False
    with pytest.raises(NativePending):
        batch.native_review_gateway(bound,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    resumed = operation_context({**ctx,'deadline':ctx['deadline']+100}, bound['operation_id'])
    assert resumed['deadline'] == ctx['deadline']
    assert batch._native_business_context({**ctx,'operation_id':'new-actions-run'},'batch',{'job_id':'job','batch_id':'batch'})['operation_id'] == bound['operation_id']


def test_publication_private_ledger_restores_known_task_and_cached_result_without_new_store(tmp_path):
    from native_tasks import (NativePending,publication_checkpoint,restore_publication_checkpoint,
                              operation_context,preflight_publication)
    ctx, wire = context(tmp_path);ctx['deadline'] += 600
    identity={'draftId':'draft','version':1,'publicationId':'publication'}
    ctx=batch._native_business_context(ctx,'publication',identity)
    snapshots=[];ctx['persist']=lambda:snapshots.append(publication_checkpoint(ctx))
    wire.complete=False
    image=photo(tmp_path)
    with pytest.raises(NativePending):
        batch.native_review_gateway(ctx,stage='publication')('prompt',[{'id':'p'}],[image],SCHEMA,tmp_path)
    assert snapshots[0]['value']['task_id'] is None
    assert snapshots[-1]['value']['task_id']
    fresh=tmp_path/'publication-restart';fresh.mkdir(mode=0o700)
    resumed=restore_publication_checkpoint({**ctx,'state_root':fresh,'deadline':ctx['deadline']+100},snapshots[-1])
    assert resumed['deadline']==ctx['deadline']
    snapshots=[];resumed['persist']=lambda:snapshots.append(publication_checkpoint(resumed))
    task=next(iter(wire.records));wire.complete_task(task)
    assert batch.native_review_gateway(resumed,stage='publication')('prompt',[{'id':'p'}],[image],SCHEMA,tmp_path)=={'ok':True}
    stored=snapshots[-1];assert stored['value']['accepted_output']=={'ok':True}
    wire.clock[0]+=61
    count=len(wire.calls);preflight_publication(resumed)
    assert batch.native_review_gateway(resumed,stage='publication')('prompt',[{'id':'p'}],[image],SCHEMA,tmp_path)=={'ok':True}
    assert len(wire.calls)==count and sum(m=='POST' and p=='/v1/tasks' for m,p,_ in wire.calls)==1
    assert len(json.dumps(stored))<16384 and 'base64' not in json.dumps(stored)


def test_publication_expiry_stops_before_media_download_and_cancel_is_reserved_once(tmp_path):
    from native_tasks import NativePending,NativeStopped,publication_checkpoint,preflight_publication
    ctx,wire=context(tmp_path);ctx['deadline']+=600
    ctx=batch._native_business_context(ctx,'publication',{'draftId':'draft','version':1,'publicationId':'publication'})
    snapshots=[];ctx['persist']=lambda:snapshots.append(publication_checkpoint(ctx))
    wire.complete=False
    with pytest.raises(NativePending):
        batch.native_review_gateway(ctx,stage='publication')('prompt',[{'id':'p'}],[photo(tmp_path)],SCHEMA,tmp_path)
    wire.clock[0]+=61
    for _ in range(2):
        with pytest.raises(NativeStopped):preflight_publication(ctx)
    assert sum(path.endswith('/cancel') for _,path,_ in wire.calls)==1
    assert snapshots[-1]['value']['cancel'] is True and snapshots[-1]['value']['halt'] is True
    assert next(iter(wire.records.values()))['status']=='cancel_requested'


def test_actual_publication_entry_restores_and_stops_before_download_or_job_claim(tmp_path):
    from native_tasks import NativePending, publication_checkpoint
    ctx,wire=context(tmp_path);ctx['deadline']+=600
    identity={'draftId':'draft','version':1,'publicationId':'publication'}
    original=batch._native_business_context(ctx,'publication',identity)
    wire.complete=False
    with pytest.raises(NativePending):
        batch.native_review_gateway(original,stage='publication')('prompt',[{'id':'p'}],[photo(tmp_path)],SCHEMA,tmp_path)
    checkpoint=publication_checkpoint(original)
    wire.clock[0]+=61
    directory=tmp_path/'restarted';directory.mkdir(mode=0o700)
    calls=[]
    def request(url, **kwargs):
        path=url.removeprefix('https://photo.invalid');body=kwargs.get('body');calls.append((path,body))
        if path=='/internal/autopublish' and body['action']=='candidate':
            return json.dumps({'draft':{'id':'draft','version':1,'photos':[{'id':'p'}]},
                'publication':{'id':'publication','status':'prepared','expires':ctx['deadline']*1000},'nativeCheckpoint':checkpoint}).encode()
        if path=='/internal/autopublish' and body['action']=='native_checkpoint':
            return b'{}'
        assert path=='/internal/maintenance'
        return b'{}'
    with patch.dict('os.environ',{'PHOTOSTORY_URL':'https://photo.invalid','PHOTOSTORY_BATCH_TOKEN':'synthetic',
              'PHOTOSTORY_STATE_DIR':str(directory),'PHOTOSTORY_STATE_BACKEND':'local'},clear=True), \
         patch.object(batch,'request',side_effect=request):
        with pytest.raises(batch.Stop,match='automatic_publication_unavailable'):
            batch.run(native_context=ctx)
    assert sum(path.endswith('/cancel') for _,path,_ in wire.calls)==1
    assert not any(path=='/internal/claim' or body and body.get('action')=='original' for path,body in calls)


def test_aggregate_real_jpeg_bytes_stop_at_existing_service_cap_without_resizing(tmp_path):
    from native_tasks import NativeStopped
    ctx,wire=context(tmp_path)
    image=tmp_path/'noise.jpg'
    Image.effect_noise((1000,1000),128).convert('RGB').save(image,'JPEG',quality=95)
    before=image.read_bytes()
    assert len(before)<15_000_000 and len(before)*4>2_000_000
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx,stage='screen')('prompt',[{'id':str(i)} for i in range(4)],
            [image]*4,SCHEMA,tmp_path)
    assert image.read_bytes()==before and wire.calls==[]
    assert not (ctx['state_root']/'native.sqlite3').exists()


def test_oversize_result_is_not_cached_or_adopted(tmp_path):
    from native_tasks import NativeStopped
    ctx,wire=context(tmp_path);wire.output=lambda request:{'text':'x'*131073}
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],{'type':'object'},tmp_path)
    before=len(wire.calls)
    with pytest.raises(NativeStopped):
        batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],{'type':'object'},tmp_path)
    assert len(wire.calls)==before


def test_resume_reads_timely_terminal_after_execution_ttl_without_extending_business_deadline(tmp_path):
    import cloud_inventory
    from native_tasks import NativePending, operation_context, publication_checkpoint
    ctx,wire=context(tmp_path);ctx['deadline']+=3600
    original_deadline=ctx['deadline'];original_start=wire.clock[0]
    wire.complete=False
    snapshots=[];ctx['persist']=lambda:snapshots.append(cloud_inventory.archive(ctx['state_root']))
    def call(context):
        return batch.native_review_gateway(context,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending):call(ctx)
    task=next(iter(wire.records));task_deadline=wire.records[task]['deadline']
    wire.clock[0]=original_start+20;wire.complete_task(task)
    wire.clock[0]=original_start+1800
    fresh=tmp_path/'restart';cloud_inventory.restore(fresh,snapshots[-1])
    resumed=operation_context({**ctx,'state_root':fresh.resolve(),'persist':lambda:None},ctx['operation_id'])
    before=len(wire.calls)
    assert call(resumed)=={'ok':True}
    assert wire.calls[before:]==[('GET','/v1/tasks/'+task,None)]
    assert resumed['deadline']==original_deadline and wire.records[task]['deadline']==task_deadline
    # A durable verified completion is distinct from its later adoption time.
    receipt=publication_checkpoint(resumed)['value']
    assert receipt['completed_at']<task_deadline<receipt['accepted_at']<original_deadline
    assert call(resumed)=={'ok':True} and len(wire.calls)==before+1
    assert sum(m=='POST' and path=='/v1/tasks' for m,path,_ in wire.calls)==1


def bootstrap_binding(ctx):
    return {**{k:v for k,v in ctx.items() if k!='client'}, 'enabled':True,
            'routes':json.loads(json.dumps(ctx['routes'])),
            'service_url':ctx['client'].resource,'audience':ctx['client'].resource+'/mcp'}


@pytest.mark.parametrize('disabled',[None,{'enabled':False}])
def test_run_without_enabled_binding_never_bootstraps_or_touches_business(disabled):
    factory=MagicMock()
    with patch.object(batch,'request') as request, patch.dict('os.environ',{
        'CODEX_GATEWAY_SERVICE_URL':'https://legacy.invalid','AI_SERVICE_URL':'https://native.invalid',
        'AI_SERVICE_AUDIENCE':'https://native.invalid/mcp'},clear=True):
        with pytest.raises(batch.Stop):batch.run(native_binding=disabled,native_client_factory=factory)
    factory.assert_not_called();request.assert_not_called()


@pytest.mark.parametrize('invalid',['project','provider','missing_stage','worker','mcp_base','query','audience',
    'expired','infinite','unknown_field','production_placeholder','production_placeholder_dot',
    'production_localhost_dot','state_permissions'])
def test_bootstrap_rejects_incomplete_binding_before_client_or_task(tmp_path,invalid):
    from native_tasks import bootstrap_context,NativeStopped
    ctx,wire=context(tmp_path);binding=bootstrap_binding(ctx);factory=MagicMock()
    if invalid=='project':binding['project']='other/PhotoStory'
    if invalid=='provider':binding['routes']['screen']['provider']='api'
    if invalid=='missing_stage':binding['routes'].pop('publication')
    if invalid=='worker':binding['routes']['screen']['worker']=''
    if invalid=='mcp_base':binding['service_url']+='/mcp'
    if invalid=='query':binding['service_url']+='?token=synthetic'
    if invalid=='audience':binding['audience']=''
    if invalid=='expired':binding['deadline']=wire.clock[0]
    if invalid=='infinite':binding['deadline']=float('inf')
    if invalid=='unknown_field':binding['token']='synthetic'
    if invalid=='production_placeholder':binding['synthetic_only']=False
    if invalid in {'production_placeholder_dot','production_localhost_dot'}:
        binding.update(synthetic_only=False,audience='https://identity.acme.org/resource',
            service_url='https://personal.invalid.' if invalid=='production_placeholder_dot' else 'https://localhost.')
    if invalid=='state_permissions':ctx['state_root'].chmod(0o755)
    with pytest.raises(NativeStopped):bootstrap_context(binding,client_factory=factory)
    factory.assert_not_called();assert wire.calls==[]


def test_bootstrap_is_explicit_single_route_and_copies_binding_before_original_consumer(tmp_path):
    from native_tasks import bootstrap_context
    ctx,wire=context(tmp_path);binding=bootstrap_binding(ctx);seen=[]
    def factory(base,audience):seen.append((base,audience));return ctx['client']
    built=bootstrap_context(binding,client_factory=factory)
    binding['routes']['labels']['provider']='changed-after-bootstrap'
    assert built['routes']['labels']['provider']=='dot'
    assert seen==[(wire.resource,wire.resource+'/mcp')] and wire.calls==[]
    operation=batch._native_business_context(built,'batch',{'job_id':'job','batch_id':'batch'})
    assert batch.native_review_gateway(operation,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)=={'ok':True}
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in wire.calls)==1


def test_run_consumes_explicit_bootstrap_before_existing_maintenance_and_claim(tmp_path):
    ctx,wire=context(tmp_path);binding=bootstrap_binding(ctx);seen=[]
    def factory(base,audience):seen.append((base,audience));return ctx['client']
    def request(url,**kwargs):
        assert seen and url in {'https://photo.invalid/internal/maintenance','https://photo.invalid/internal/claim'}
        return b'null' if url.endswith('/claim') else b'{}'
    with patch.dict('os.environ',{'PHOTOSTORY_URL':'https://photo.invalid','PHOTOSTORY_BATCH_TOKEN':'synthetic',
             'PHOTOSTORY_STATE_BACKEND':'local'},clear=True),patch.object(batch,'request',side_effect=request), \
         patch('auto_publish.tick',return_value=False) as tick:
        batch.run(native_binding=binding,native_client_factory=factory)
    assert len(seen)==1 and tick.call_count==1 and wire.calls==[]


def test_bootstrap_rejects_ambiguous_context_and_mismatched_client_before_business(tmp_path):
    from native_tasks import bootstrap_context,NativeStopped
    ctx,wire=context(tmp_path);binding=bootstrap_binding(ctx);factory=MagicMock(return_value=ctx['client'])
    with patch.object(batch,'request') as request:
        with pytest.raises(batch.Stop):batch.run(native_context=ctx,native_binding=binding,native_client_factory=factory)
    factory.assert_not_called();request.assert_not_called()
    other=MagicMock(resource='https://other.invalid')
    with pytest.raises(NativeStopped):bootstrap_context(binding,client_factory=lambda base,audience:other)
    assert wire.calls==[]


def test_explicit_nonsynthetic_binding_needs_real_shaped_endpoints_and_retains_route_guard(tmp_path):
    from native_tasks import bootstrap_context,validate_context,NativeStopped
    ctx,wire=context(tmp_path);binding=bootstrap_binding(ctx)
    binding.update(synthetic_only=False,service_url='https://tasks.acme.org',audience='https://identity.acme.org/resource')
    client=MagicMock(resource=binding['service_url']);factory=MagicMock(return_value=client)
    built=bootstrap_context(binding,client_factory=factory)
    factory.assert_called_once_with('https://tasks.acme.org','https://identity.acme.org/resource')
    assert built['deadline']==ctx['deadline'] and wire.calls==[]
    built['routes']['screen']['worker']='other-worker'
    with pytest.raises(NativeStopped):validate_context(built)
    client.submit.assert_not_called();client.get.assert_not_called();client.cancel.assert_not_called()


def test_existing_sdk_constructor_defers_workload_token_until_request(tmp_path):
    from native_tasks import bootstrap_context
    import types
    ctx,wire=context(tmp_path);binding=bootstrap_binding(ctx);created=[];tokens=[]
    def constructor(base,token,*,max_response_bytes):
        created.append((base,token,max_response_bytes));return ctx['client']
    sdk=types.ModuleType('ai_service.client');sdk.TaskClient=constructor
    sdk.github_token=lambda audience:tokens.append(audience) or 'synthetic-token'
    package=types.ModuleType('ai_service');package.client=sdk
    with patch.dict(sys.modules,{'ai_service':package,'ai_service.client':sdk}):
        bootstrap_context(binding)
        assert len(created)==1 and created[0][0]==wire.resource and created[0][2]==2_000_000
        assert tokens==[] and wire.calls==[]
        assert created[0][1]()=='synthetic-token'
    assert tokens==[wire.resource+'/mcp'] and wire.calls==[]


def test_bootstrap_reuses_original_checkpoint_task_and_cannot_refresh_business_deadline(tmp_path):
    import cloud_inventory
    from native_tasks import bootstrap_context,NativePending
    ctx,wire=context(tmp_path);ctx['deadline']+=3600;wire.complete=False;snapshots=[]
    ctx['persist']=lambda:snapshots.append(cloud_inventory.archive(ctx['state_root']))
    identity={'job_id':'job','batch_id':'batch'}
    original=batch._native_business_context(bootstrap_context(bootstrap_binding(ctx),client_factory=lambda *_:ctx['client']),'batch',identity)
    def call(context):return batch.native_review_gateway(context,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending):call(original)
    task=next(iter(wire.records));wire.clock[0]+=20;wire.complete_task(task);wire.clock[0]+=1780
    restart=tmp_path/'bootstrap-restart';cloud_inventory.restore(restart,snapshots[-1])
    binding=bootstrap_binding(ctx);binding.update(state_root=restart.resolve(),persist=lambda:None,deadline=ctx['deadline']+1000)
    resumed=batch._native_business_context(bootstrap_context(binding,client_factory=lambda *_:ctx['client']),'batch',identity)
    before=len(wire.calls)
    assert resumed['deadline']==original['deadline'] and call(resumed)=={'ok':True}
    assert wire.calls[before:]==[('GET','/v1/tasks/'+task,None)]
    assert sum(m=='POST' and path=='/v1/tasks' for m,path,_ in wire.calls)==1


@pytest.mark.parametrize('invalid', ['late','late_report','missing_time','nan_time','future_creation','provider','revision','request','worker'])
def test_post_ttl_readback_rejects_unproven_completion_or_identity_without_replacement(tmp_path,invalid):
    from native_tasks import NativePending,NativeStopped
    ctx,wire=context(tmp_path);ctx['deadline']+=3600;wire.complete=False
    call=lambda:batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending):call()
    task=next(iter(wire.records))
    if invalid=='late_report':wire.clock[0]+=61
    wire.complete_task(task);wire.clock[0]+=1800
    def mutate(record):
        if invalid=='late':record['updated']=record['deadline']
        elif invalid=='missing_time':record.pop('updated')
        elif invalid=='nan_time':record['updated']=float('nan')
        elif invalid=='future_creation':record['created']=record['updated']+1
        elif invalid=='provider':record['provider']='other'
        elif invalid=='revision':record['revision']+=1
        elif invalid=='request':record['request']['objective']='drift'
        elif invalid=='worker':record['worker']='other'
        return record
    wire.mutate=mutate;before=len(wire.calls)
    with pytest.raises(NativeStopped):call()
    assert wire.calls[before:]==[('GET','/v1/tasks/'+task,None)]
    before=len(wire.calls)
    with pytest.raises(NativeStopped):call()
    assert len(wire.calls)==before
    assert sum(m=='POST' and path=='/v1/tasks' for m,path,_ in wire.calls)==1


def test_actual_publication_resumes_timely_terminal_before_media_and_consumes_original_review(tmp_path):
    import auto_publish
    from auto_review import FIELDS,PROMPT,SCHEMA as REVIEW_SCHEMA
    from native_tasks import NativePending,publication_checkpoint
    ctx,wire=context(tmp_path);ctx['deadline']+=3600;wire.complete=False
    frame={'mode':'crop','x':50,'y':50}
    draft={'id':'draft','version':1,'aspect':'3:2','approvalSource':'strict_ai_v1',
           'photos':[{'id':'p','frame':frame}]}
    identity={'draftId':'draft','version':1,'publicationId':'publication'}
    original=batch._native_business_context(ctx,'publication',identity)
    wire.output=lambda request:{key:key!='needsHumanReview' for key in FIELDS}
    raw=photo(tmp_path,(1800,1200)).read_bytes()
    rendered=tmp_path/'rendered.jpg';rendered.write_bytes(auto_publish.render(raw,'3:2',frame))
    prompt=PROMPT+'\nFinal original-resolution post (data):\n'+json.dumps(draft,ensure_ascii=False)
    with pytest.raises(NativePending):
        batch.native_review_gateway(original,stage='publication')(prompt,[{'id':'p'}],[rendered],REVIEW_SCHEMA,tmp_path)
    checkpoint=publication_checkpoint(original)
    task=next(iter(wire.records));wire.complete_task(task);wire.clock[0]+=1800
    directory=tmp_path/'new-run';directory.mkdir(mode=0o700)
    calls=[];stored=[];before=len(wire.calls)
    def request(url,**kwargs):
        path=url.removeprefix('https://photo.invalid');body=kwargs.get('body');calls.append((path,body))
        if path=='/internal/maintenance':return b'{}'
        assert path=='/internal/autopublish'
        if body['action']=='candidate':value={'draft':draft,'publication':{'id':'publication','status':'prepared','expires':ctx['deadline']*1000},'nativeCheckpoint':checkpoint}
        elif body['action']=='native_checkpoint':
            stored.append(body['checkpoint']);value={}
        elif body['action']=='original':
            assert stored[-1]['value']['accepted_output']==wire.output(None)
            return raw
        elif body['action']=='upload':value={}
        elif body['action']=='begin':
            assert body['review']==wire.output(None)
            assert body['images']==[{'id':'p','digest':hashlib.sha256(rendered.read_bytes()).hexdigest()}]
            value={'id':'publication','status':'publishing'}
        else:raise AssertionError(body['action'])
        return json.dumps(value).encode()
    with patch.dict('os.environ',{'PHOTOSTORY_URL':'https://photo.invalid','PHOTOSTORY_BATCH_TOKEN':'synthetic',
             'PHOTOSTORY_STATE_DIR':str(directory),'PHOTOSTORY_STATE_BACKEND':'local'},clear=True), \
         patch.object(batch,'request',side_effect=request),patch.object(auto_publish,'finish_publication',return_value=True) as finish:
        batch.run(native_context=ctx)
    assert finish.call_count==1 and any(body and body.get('action')=='begin' for _,body in calls)
    assert wire.calls[before:]==[('GET','/v1/tasks/'+task,None)]
    assert sum(m=='POST' and path=='/v1/tasks' for m,path,_ in wire.calls)==1


@pytest.mark.parametrize('stop',['cancel','business_deadline'])
def test_post_ttl_completion_cannot_bypass_owner_cancel_or_business_deadline(tmp_path,stop):
    from native_tasks import NativePending,NativeStopped
    ctx,wire=context(tmp_path);wire.complete=False
    if stop=='cancel':ctx['deadline']+=3600
    call=lambda:batch.native_review_gateway(ctx,stage='labels')('prompt',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending):call()
    task=next(iter(wire.records));wire.complete_task(task);wire.clock[0]+=1800
    if stop=='cancel':ctx['cancel']=True
    before=len(wire.calls)
    for _ in range(2):
        with pytest.raises(NativeStopped):call()
    assert wire.calls[before:]==[('POST','/v1/tasks/'+task+'/cancel',None)]


@pytest.mark.parametrize('entry',['task_call','publication_preflight'])
def test_durable_cancel_with_lost_checkpoint_ack_survives_fresh_context_and_timely_remote_completion(tmp_path,entry):
    import cloud_inventory
    from native_tasks import NativePending,NativeStopped,operation_context,preflight_publication
    ctx,wire=context(tmp_path);ctx['deadline']+=3600;wire.complete=False
    ctx=batch._native_business_context(ctx,'publication',{'draftId':'draft','version':1,'publicationId':'publication'})
    image=photo(tmp_path);snapshots=[];lose=[False]
    def persist():
        snapshots.append(cloud_inventory.archive(ctx['state_root']))
        if lose[0]:raise TimeoutError('synthetic checkpoint acknowledgement lost')
    ctx['persist']=persist
    def call(context):return batch.native_review_gateway(context,stage='publication')('prompt',[{'id':'p'}],[image],SCHEMA,tmp_path)
    with pytest.raises(NativePending):call(ctx)
    before=len(wire.calls);ctx['cancel']=True;lose[0]=True
    with pytest.raises(NativeStopped):call(ctx)
    assert len(wire.calls)==before
    wire.clock[0]+=20;wire.complete_task(next(iter(wire.records)));wire.clock[0]+=1780
    fresh=tmp_path/'cancel-restart';cloud_inventory.restore(fresh,snapshots[-1])
    resumed=operation_context({**ctx,'cancel':False,'state_root':fresh.resolve(),'persist':lambda:None},ctx['operation_id'])
    for _ in range(2):
        with pytest.raises(NativeStopped):
            if entry=='task_call':call(resumed)
            else:preflight_publication(resumed)
    assert len(wire.calls)==before
    assert sum(m=='POST' and path=='/v1/tasks' for m,path,_ in wire.calls)==1


class PendingBatchHarness:
    """Actual private Inventory and caller; generated JPEG and fake business I/O."""
    def __init__(self, root, *, cloud=False, source_overrides=None):
        from inventory import Inventory
        self.cloud = cloud
        self.snapshots, self.pointer = {}, None
        self.root = root
        self.ctx, self.wire = context(root)
        self.started = self.wire.clock[0]
        self.ctx['deadline'] = self.started + 3600  # Proposed adoption age; not task TTL.
        self.directory = self.ctx['state_root']
        self.source = {'pipeline':2, 'folder':'synthetic-folder', 'start':1, 'end':2,
                       'maxPhotos':1, 'draftLimit':1, 'accessToken':'synthetic', 'progress':{}}
        self.source.update(source_overrides or {})
        policy = hashlib.sha256((batch.SCREEN_PROMPT+batch.GROUP_PROMPT).encode()).hexdigest()
        self.p = {'id':'p', 'captured':'2026-08-18T10:00:00+08:00', 'taken':1000, 'area':None}
        inv = Inventory(self.directory, 'job', self.source, policy)
        with inv.db:
            inv.set('initialized', True)
            inv.db.execute("INSERT INTO photos(id,body,taken,status) VALUES(?,?,?,?)",
                           ('p',json.dumps(self.p),1000,'pending'))
        self.source['progress'] = {**inv.progress(), 'phase':'processing'}
        inv.close()
        self.image = photo(root).read_bytes()
        self.calls, self.completed = [], []
        self.fail_checkpoint = self.fail_complete = False
        self.fail_completion_checkpoint = None
        self.wire.complete = False
        self.wire.output = lambda request: {'photos':[{
            'id':'p','decision':'exclude','flags':[],'landscape':False,'aesthetic':0,
            'description':'Synthetic exclusion','peopleRole':'none','compositionClear':False,
            'contentKind':'uncertain','light':'unknown','scene':'unknown',
            'place':{'city':'','landmark':'','evidence':'','confidence':'none'}}]}

    def request(self, url, **kwargs):
        body = kwargs.get('body') or {}
        path = url.removeprefix('https://photo.invalid')
        self.calls.append((path,json.loads(json.dumps(body))))
        if path == '/internal/claim': result = {'id':'job','lease':'synthetic-lease'}
        elif path == '/internal/source': result = self.source
        elif path == '/internal/checkpoint':
            import sqlite3
            final_intent = False
            if self.fail_completion_checkpoint and body.get('nativeCheckpoint') is True:
                with sqlite3.connect(self.directory/'job.sqlite3') as db:
                    row = db.execute("SELECT value FROM meta WHERE key='native_pending'").fetchone()
                with sqlite3.connect(self.directory/'native.sqlite3') as db:
                    values = [json.loads(r[0]) for r in db.execute('SELECT value FROM native_operations')]
                final_intent = bool(row and json.loads(row[0]) is None and values
                                    and all(v.get('accepted_output') is not None for v in values))
                if final_intent and self.fail_completion_checkpoint == 'before_commit':
                    raise TimeoutError('synthetic final intent checkpoint rejected')
            self.source['progress'] = json.loads(json.dumps(body['progress']))
            if self.cloud: self.pointer = body['inventoryRef']
            if self.fail_checkpoint or (final_intent and self.fail_completion_checkpoint == 'after_commit'):
                raise TimeoutError('synthetic checkpoint acknowledgement lost')
            result = {}
        elif path == '/internal/complete':
            if self.fail_complete: raise TimeoutError('synthetic completion acknowledgement lost')
            if self.cloud: self.pointer = body['inventoryRef']
            self.completed.append(body)
            self.source.update(lastBatch=body['batchId'],progress=body['progress'])
            result = {'count':0}
        elif path in {'/internal/maintenance','/internal/fail'}: result = {}
        else: raise AssertionError('unexpected fake business request: '+path)
        return json.dumps(result).encode()

    def run(self, *, workflow_env=None):
        import cloud_inventory
        h = self
        class Cloud:
            def __init__(self,*args): pass
            def require_seed(self): pass
            def load(self, directory, job, lease):
                assert job == 'job' and lease == 'synthetic-lease'
                if h.pointer is None: return False
                # A fresh ephemeral caller sees only the acknowledged pointer.
                for path in Path(directory).iterdir():
                    assert path.is_file() and not path.is_symlink()
                    path.unlink()
                cloud_inventory.restore(directory,h.snapshots[h.pointer])
                return True
            def save(self, directory, job, lease, source, policy, batch_id=None):
                assert job == 'job' and lease == 'synthetic-lease'
                ref = '00000000-0000-4000-8000-'+str(len(h.snapshots)+1).zfill(12)
                h.snapshots[ref] = cloud_inventory.archive(directory,job,source,policy,batch_id)
                return ref
        with patch.dict('os.environ',{'PHOTOSTORY_URL':'https://photo.invalid',
                 'PHOTOSTORY_BATCH_TOKEN':'synthetic','PHOTOSTORY_STATE_DIR':str(self.directory),
                 'PHOTOSTORY_STATE_BACKEND':'cloudflare' if self.cloud else 'local',
                 **(workflow_env or {})},clear=True), \
             patch('cloud_inventory.CloudInventory',Cloud), \
             patch.object(batch,'request',side_effect=self.request), \
             patch('auto_publish.tick',return_value=False), \
             patch.object(batch,'thumbnail',return_value=self.image), \
             patch.object(batch,'graph',side_effect=AssertionError('no real media/scan')), \
             patch('preselect.representatives',side_effect=lambda previews,*args:[(v,data,{}) for v,data in previews]), \
             patch.object(batch,'gateway',side_effect=AssertionError('retired gateway')):
            if workflow_env is None: batch.run(native_context=self.ctx)
            else: batch.main()

    def timely_result(self, resume=1800):
        task = next(iter(self.wire.records))
        self.wire.clock[0] = self.started + 20
        self.wire.complete_task(task)
        self.wire.clock[0] = self.started + resume
        return task


@pytest.mark.parametrize('cloud', [False,True])
@pytest.mark.parametrize('resume', [30,1800,3599])
def test_actual_inventory_known_pending_resumes_same_task_with_finite_adoption_candidate(tmp_path, resume, cloud):
    h = PendingBatchHarness(tmp_path,cloud=cloud)
    h.run()
    assert len(h.wire.records) == 1 and not h.completed
    task = h.timely_result(resume)
    h.run()
    assert len(h.completed) == 1 and h.completed[0]['photos'] == []
    assert [p for m,p,_ in h.wire.calls if m == 'GET'] == ['/v1/tasks/'+task]
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in h.wire.calls) == 1
    # Task TTL remains sixty seconds even with a separate 60 minute adoption candidate.
    assert h.wire.records[task]['request']['timeout_seconds'] == 60


@pytest.mark.parametrize('change', ['missing_marker','input','progress','inventory','ledger','unknown_intent','cancel','expired','route','last_batch','marker'])
def test_actual_inventory_pending_drift_or_unknown_never_gets_or_resubmits(tmp_path, change):
    import sqlite3
    h = PendingBatchHarness(tmp_path); h.run(); h.timely_result()
    if change == 'route': h.ctx['routes']['screen']['worker'] = 'wrong-worker'
    elif change == 'last_batch': h.source['lastBatch'] = 'wrong-batch'
    elif change == 'input': h.source['locationHint'] = 'changed'
    elif change == 'progress': h.source['progress']['total'] += 1
    elif change == 'cancel': h.ctx['cancel'] = True
    elif change == 'expired': h.wire.clock[0] = h.started+3600
    else:
        with sqlite3.connect(h.directory/('native.sqlite3' if change in {'ledger','unknown_intent'} else 'job.sqlite3')) as db:
            if change in {'ledger','unknown_intent'}:
                key,raw = db.execute('SELECT operation,value FROM native_operations').fetchone()
                value = json.loads(raw)
                if change == 'ledger': value['revision'] += 1
                else: value['task_id'] = None
                db.execute('UPDATE native_operations SET value=? WHERE operation=?',(json.dumps(value),key))
            elif change == 'missing_marker': db.execute("DELETE FROM meta WHERE key='native_pending'")
            elif change == 'marker': db.execute("UPDATE meta SET value='{}' WHERE key='native_pending'")
            else: db.execute("UPDATE photos SET taken=taken+1")
    before = len(h.wire.calls)
    with pytest.raises(batch.Stop): h.run()
    # A cancel can send one cancellation; never another GET or task creation.
    assert not any(m=='GET' or p=='/v1/tasks' for m,p,_ in h.wire.calls[before:])
    assert len(h.wire.records) == 1 and not h.completed


@pytest.mark.parametrize('cloud', [False,True])
def test_actual_inventory_completion_unknown_is_not_pending_retry(tmp_path, cloud):
    h = PendingBatchHarness(tmp_path,cloud=cloud); h.run(); h.timely_result()
    h.fail_complete = True
    with pytest.raises(batch.Stop): h.run()
    before = len(h.wire.calls)
    with pytest.raises(batch.Stop): h.run()
    assert h.wire.calls[before:] == [] and not h.completed
    assert sum(p=='/internal/complete' for p,_ in h.calls) == 1


@pytest.mark.parametrize('cloud', [False,True])
def test_actual_inventory_second_pending_checkpoint_keeps_original_task_and_batch(tmp_path, cloud):
    h = PendingBatchHarness(tmp_path,cloud=cloud); h.run()
    h.wire.clock[0] = h.started+10
    h.run()  # Still running: acknowledge another wait, with no replacement POST.
    assert len(h.wire.records) == 1 and not h.completed
    task = h.timely_result()
    h.run()
    assert len(h.completed) == 1
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in h.wire.calls) == 1
    assert [p for m,p,_ in h.wire.calls if m=='GET'] == ['/v1/tasks/'+task]*2


@pytest.mark.parametrize('cloud', [False,True])
@pytest.mark.parametrize('failure', ['before_commit','after_commit'])
def test_actual_inventory_completion_intent_checkpoint_lost_ack_prevents_complete(tmp_path, cloud, failure):
    h = PendingBatchHarness(tmp_path,cloud=cloud); h.run(); h.timely_result()
    h.fail_completion_checkpoint = failure
    with pytest.raises(batch.Stop): h.run()
    assert not h.completed and not any(p=='/internal/complete' for p,_ in h.calls)
    before = len(h.wire.calls)
    h.fail_completion_checkpoint = None
    with pytest.raises(batch.Stop): h.run()
    assert h.wire.calls[before:] == []


def test_actual_inventory_owner_stop_preserves_pending_without_result_or_new_submit(tmp_path):
    h = PendingBatchHarness(tmp_path); h.run(); h.timely_result()
    h.source['stopRequested'] = True
    before = len(h.wire.calls)
    h.run()
    assert h.wire.calls[before:] == [] and not h.completed
    assert h.calls[-1][0] == '/internal/checkpoint'


@pytest.mark.parametrize('cloud', [False,True])
def test_actual_inventory_cached_screen_then_pending_group_reuses_both_identities(tmp_path, cloud):
    h = PendingBatchHarness(tmp_path,cloud=cloud)
    safe = {'id':'p','decision':'allow','flags':[],'landscape':True,'aesthetic':9,
            'description':'Coast','peopleRole':'none','compositionClear':True,
            'contentKind':'permanent_scenery','light':'day','scene':'architecture',
            'place':{'city':'','landmark':'','evidence':'','confidence':'none'}}
    h.wire.output = lambda request: {'photos':[safe]} if request['profile']=='screen' else {'drafts':[]}
    submit = h.wire.submit
    def controlled_submit(request,key):
        h.wire.complete = request['profile'] != 'group'
        return submit(request,key)
    h.wire.submit = controlled_submit
    h.run()
    assert len(h.wire.records) == 2 and not h.completed
    task = next(k for k,v in h.wire.records.items() if v['request']['profile']=='group')
    h.wire.clock[0] = h.started+20; h.wire.complete_task(task)
    h.wire.clock[0] = h.started+1800
    h.run()
    assert len(h.completed) == 1 and h.completed[0]['drafts'] == []
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in h.wire.calls) == 2
    assert [p for m,p,_ in h.wire.calls if m=='GET'] == ['/v1/tasks/'+task]


def test_actual_inventory_restart_cannot_extend_original_adoption_deadline(tmp_path):
    h = PendingBatchHarness(tmp_path); h.run(); h.timely_result(resume=3600)
    h.ctx['deadline'] = h.started+7200
    before = len(h.wire.calls)
    for _ in range(2):
        with pytest.raises(batch.Stop): h.run()
    assert h.wire.calls[before:] == [] and not h.completed


def workflow_config():
    return {'enabled':True,'project':'Pigbibi/PhotoStory','service_url':'https://personal.acme.org',
            'audience':'https://personal.acme.org/mcp','adoption_age_seconds':3600,
            'routes':{stage:{'mode':'agent','provider':'dot','profile':stage,'model':'gpt-6-sol',
                             'worker':'dot-personal'} for stage in STAGES}}


@pytest.mark.parametrize('invalid',['missing','disabled','extra','project','ttl','mixed_provider','mixed_worker','unknown_profile','over_age'])
def test_workflow_binding_requires_exact_single_handler_before_client_or_business(tmp_path,invalid):
    config=workflow_config()
    if invalid=='disabled':config['enabled']=False
    if invalid=='extra':config['token']='not-allowed'
    if invalid=='project':config['project']='QuantStrategyLab/QuantAIService'
    if invalid=='ttl':config['timeout_seconds']=600
    if invalid=='mixed_provider':config['routes']['cross_review']['provider']='grok'
    if invalid=='mixed_worker':config['routes']['cross_review']['worker']='other'
    if invalid=='unknown_profile':config['routes']['cross_review']['profile']='helper'
    if invalid=='over_age':config['adoption_age_seconds']=3601
    raw='' if invalid=='missing' else json.dumps(config)
    with patch.dict('os.environ',{'PHOTOSTORY_NATIVE_BINDING':raw},clear=True),patch.object(batch,'request') as request:
        with pytest.raises(batch.Stop):batch.workflow_binding(tmp_path,tmp_path,now=lambda:100)
    request.assert_not_called()


def test_workflow_binding_is_explicit_and_preserves_sixty_second_execution_contract(tmp_path):
    config=workflow_config()
    with patch.dict('os.environ',{'PHOTOSTORY_NATIVE_BINDING':json.dumps(config)},clear=True):
        binding=batch.workflow_binding(tmp_path,tmp_path,now=lambda:100)
    assert binding['deadline']==100+51*3600 and binding['synthetic_only'] is False
    assert binding['routes']==config['routes'] and binding['adoption_age_seconds']==3600
    assert binding['task_limit']==51
    assert binding['limits']=={'request_bytes':2_000_000,'response_bytes':2_000_000}
    assert binding['project']=='Pigbibi/PhotoStory' and 'client' not in binding


def test_actual_processor_uses_public_factory_without_private_sdk_or_token_at_bootstrap(tmp_path):
    import github_gateway
    ctx,wire=context(tmp_path);binding=bootstrap_binding(ctx);made=[]
    def factory(resource,audience):made.append((resource,audience));return wire
    with patch.object(github_gateway,'NativeTaskClient',side_effect=factory), \
         patch.dict(sys.modules,{'ai_service':None,'ai_service.client':None}), \
         patch.dict('os.environ',{'PHOTOSTORY_URL':'https://photo.invalid','PHOTOSTORY_BATCH_TOKEN':'synthetic'},clear=True), \
         patch.object(batch,'request',side_effect=[b'{}',b'null']),patch('auto_publish.tick',return_value=False):
        batch.run(native_binding=binding)
    assert made==[(wire.resource,wire.resource+'/mcp')] and wire.calls==[]


def http_client(ctx, wire):
    import github_gateway
    from unittest.mock import Mock
    from urllib.parse import urlsplit
    class Reply:
        status=200;headers={}
        def __init__(self,record):self.body=io.BytesIO(json.dumps(record).encode())
        def __enter__(self):return self
        def __exit__(self,*_):self.body.close()
        def read(self,n):return self.body.read(n)
    def send(request,timeout):
        path=urlsplit(request.full_url).path
        if path=='/v1/tasks':record=wire.submit(json.loads(request.data),request.get_header('Idempotency-key'))
        elif path.endswith('/cancel'):record=wire.cancel(path.split('/')[-2])
        else:record=wire.get(path.split('/')[-1])
        return Reply(record)
    opener=Mock();opener.open.side_effect=send
    client=github_gateway.NativeTaskClient(wire.resource,wire.resource+'/mcp',opener=opener,token=lambda:'synthetic')
    return {**ctx,'client':client},opener


@pytest.mark.parametrize('mode',['success','pending_resume','unknown','cancel','expiry','wrong_revision','wrong_project','wrong_provider','invalid_output'])
def test_public_http_factory_reuses_existing_ledger_and_consumer(tmp_path,mode):
    from native_tasks import NativePending,NativeStopped
    ctx,wire=context(tmp_path);ctx,opener=http_client(ctx,wire)
    if mode in {'pending_resume','cancel','expiry'}:wire.complete=False
    if mode=='unknown':wire.lose=True
    if mode=='wrong_revision':wire.mutate=lambda r:{**r,'revision':True}
    if mode=='wrong_project':wire.mutate=lambda r:{**r,'owner':'QuantStrategyLab/QuantAIService'}
    if mode=='wrong_provider':wire.mutate=lambda r:{**r,'provider':'grok'}
    if mode=='invalid_output':wire.output=lambda r:{'ok':False}
    call=lambda:batch.native_review_gateway(ctx,stage='labels')('generated',[{'id':'p'}],[],SCHEMA,tmp_path)
    if mode=='success':assert call()=={'ok':True}
    elif mode in {'pending_resume','cancel','expiry'}:
        with pytest.raises(NativePending):call()
        task=next(iter(wire.records))
        if mode=='pending_resume':wire.complete_task(task);assert call()=={'ok':True}
        else:
            if mode=='cancel':ctx['cancel']=True
            else:wire.clock[0]=ctx['deadline']+1
            for _ in range(2):
                with pytest.raises(NativeStopped):call()
            assert wire.records[task]['status']=='cancel_requested'
            assert sum(p.endswith('/cancel') for _,p,_ in wire.calls)==1
    else:
        with pytest.raises(NativeStopped):call()
        count=opener.open.call_count
        with pytest.raises(NativeStopped):call()
        assert opener.open.call_count==count
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in wire.calls)==1


@pytest.mark.parametrize('lost_response',[False,True])
def test_actual_workflow_main_oidc_http_cloud_restore_and_consumer_without_private_sdk(tmp_path,lost_response):
    import github_gateway
    from urllib.parse import urlsplit
    h=PendingBatchHarness(tmp_path,cloud=True);config=workflow_config()
    h.wire.resource=config['service_url'];h.wire.routes=config['routes']
    _,opener=http_client(h.ctx,h.wire);send=opener.open.side_effect;tokens=[]
    class TokenReply(io.BytesIO):
        status=200;headers={}
    def dispatch(request,timeout):
        if urlsplit(request.full_url).hostname.endswith('.actions.githubusercontent.com'):
            tokens.append(request.full_url)
            return TokenReply(b'{"value":"synthetic-workload-token"}')
        assert request.get_header('Authorization')=='Bearer synthetic-workload-token'
        return send(request,timeout)
    opener.open.side_effect=dispatch
    env={'PHOTOSTORY_NATIVE_BINDING':json.dumps(config),
         'ACTIONS_ID_TOKEN_REQUEST_URL':'https://pipelines.actions.githubusercontent.com/token',
         'ACTIONS_ID_TOKEN_REQUEST_TOKEN':'synthetic-request-token'}
    h.wire.lose=lost_response
    with patch.object(github_gateway.urllib.request,'build_opener',return_value=opener), \
         patch.dict(sys.modules,{'ai_service':None,'ai_service.client':None}), \
         patch('time.time',side_effect=lambda:h.wire.clock[0]):
        if lost_response:
            with pytest.raises(batch.Stop):h.run(workflow_env=env)
            count=opener.open.call_count
            with pytest.raises(batch.Stop):h.run(workflow_env=env)
            assert opener.open.call_count==count and not h.completed
        else:
            h.run(workflow_env=env)
            task=h.timely_result(resume=1800)
            h.run(workflow_env=env)
            assert len(h.completed)==1 and h.wire.records[task]['deadline']==h.started+60
            assert [m for m,_,_ in h.wire.calls]==['POST','GET']
    assert len(tokens)==(1 if lost_response else 2)
    assert sum(m=='POST' and p=='/v1/tasks' for m,p,_ in h.wire.calls)==1


def test_per_task_age_rejects_exact_expiry_without_refresh_from_later_read(tmp_path):
    from native_tasks import NativePending,NativeStopped
    ctx,wire=context(tmp_path);ctx.update(adoption_age_seconds=3600,task_limit=51,deadline=wire.clock[0]+51*3600)
    wire.complete=False
    call=lambda:batch.native_review_gateway(ctx,stage='labels')('generated',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending):call()
    created=wire.clock[0];wire.clock[0]=created+20;wire.complete_task(next(iter(wire.records)))
    wire.clock[0]=created+3600
    with pytest.raises(NativeStopped):call()
    before=len(wire.calls)
    with pytest.raises(NativeStopped):call()
    assert len(wire.calls)==before and sum(m=='POST' and p=='/v1/tasks' for m,p,_ in wire.calls)==1


def test_task_created_origin_is_frozen_and_cannot_be_rebased_on_resume(tmp_path):
    from native_tasks import NativePending,NativeStopped
    ctx,wire=context(tmp_path);ctx.update(adoption_age_seconds=3600,task_limit=51,deadline=wire.clock[0]+51*3600)
    wire.complete=False;call=lambda:batch.native_review_gateway(ctx,stage='labels')('generated',[{'id':'p'}],[],SCHEMA,tmp_path)
    with pytest.raises(NativePending):call()
    task=next(iter(wire.records));wire.clock[0]+=20;wire.complete_task(task);wire.clock[0]+=1800
    wire.mutate=lambda r:{**r,'created':r['created']+10}
    with pytest.raises(NativeStopped):call()


def test_child_count_is_bounded_and_restore_cannot_renew_parent_deadline(tmp_path):
    from native_tasks import NativeStopped,operation_context
    ctx,wire=context(tmp_path);ctx.update(adoption_age_seconds=3600,task_limit=2,deadline=wire.clock[0]+7200)
    for i in range(2):assert batch.native_review_gateway(ctx,stage='labels')('generated',[{'id':str(i)}],[],SCHEMA,tmp_path)=={'ok':True}
    with pytest.raises(NativeStopped):batch.native_review_gateway(ctx,stage='labels')('generated',[{'id':'third'}],[],SCHEMA,tmp_path)
    assert len(wire.records)==2
    restored=operation_context({**ctx,'deadline':ctx['deadline']+99999},ctx['operation_id'])
    assert restored['deadline']==ctx['deadline']


@pytest.mark.parametrize('publication_expiry',[1,3600])
def test_publication_callback_cannot_widen_original_expiry(tmp_path,publication_expiry):
    import auto_publish
    seen=[];now=100
    publication={'id':'publication','status':'prepared','expires':(now+publication_expiry)*1000}
    draft={'id':'draft','version':1,'photos':[]}
    def call(path,body):return {'draft':draft,'publication':publication} if body['action']=='candidate' else {}
    def bind(identity,checkpoint,expires_at):
        seen.append(expires_at)
        from native_tasks import NativePending
        raise NativePending('synthetic known wait')
    with pytest.raises(Exception):auto_publish.tick(call,lambda *_:None,lambda *_:None,bind_review=bind)
    assert seen==[now+publication_expiry]


def test_included_photo_main_advances_all_batch_stages_over_original_cron_with_one_task_each(tmp_path):
    import github_gateway
    from urllib.parse import urlsplit
    from auto_review import FIELDS
    h=PendingBatchHarness(tmp_path,cloud=True,source_overrides={'reviewMode':'strict_auto','strictAutoEnabled':True})
    config=workflow_config();h.wire.resource=config['service_url'];h.wire.routes=config['routes']
    def output(request):
        stage=request['profile'];records=request['materials'][0]['records']
        if stage=='screen':return {'photos':[{'id':'p','decision':'allow','flags':[],'landscape':True,'aesthetic':10,
          'description':'Generated facade','peopleRole':'none','compositionClear':True,'contentKind':'permanent_scenery',
          'light':'day','scene':'architecture','place':{'city':'','landmark':'','evidence':'','confidence':'none'}}]}
        copy={'title':'Facade','caption':'A generated facade.','hashtags':'#Architecture','reason':'Visible scenery',
              'photos':[{'id':'p','alt':'Generated facade','frame':{'mode':'crop','x':50,'y':50}}]}
        if stage=='group':return {'drafts':[copy]}
        if stage=='cross_review':return {'checks':[{'draftId':records[0]['draftId'],'duplicateIds':[],
          'captionGrounded':True,'locationGrounded':True,'copy':{**copy,'photos':[{'id':'p','alt':'Generated facade'}]}}]}
        if stage=='labels':return {'labels':[{'id':records[0]['id'],'translations':{c:{'title':'Facade','reason':'Scenery'} for c in batch.LANGUAGE_NAMES}}]}
        return {key:key!='needsHumanReview' for key in FIELDS}
    h.wire.output=output
    _,opener=http_client(h.ctx,h.wire);send=opener.open.side_effect
    class TokenReply(io.BytesIO):status=200;headers={}
    def dispatch(request,timeout):
        if urlsplit(request.full_url).hostname.endswith('.actions.githubusercontent.com'):
            return TokenReply(b'{"value":"synthetic-workload-token"}')
        return send(request,timeout)
    opener.open.side_effect=dispatch
    env={'PHOTOSTORY_NATIVE_BINDING':json.dumps(config),'ACTIONS_ID_TOKEN_REQUEST_URL':'https://pipelines.actions.githubusercontent.com/token',
         'ACTIONS_ID_TOKEN_REQUEST_TOKEN':'synthetic-request-token'}
    with patch.object(github_gateway.urllib.request,'build_opener',return_value=opener), \
         patch.dict(sys.modules,{'ai_service':None,'ai_service.client':None}),patch('time.time',side_effect=lambda:h.wire.clock[0]):
        h.run(workflow_env=env)
        for step in range(1,6):
            task=list(h.wire.records)[-1];record=h.wire.records[task]
            h.wire.clock[0]=record['created']+20;h.wire.complete_task(task)
            h.wire.clock[0]=h.started+1800*step
            h.run(workflow_env=env)
    assert len(h.completed)==1 and len(h.completed[0]['drafts'])==1
    assert [r['request']['profile'] for r in h.wire.records.values()]==['screen','group','cross_review','labels','strict_review']
    assert all(r['deadline']-r['created']==60 for r in h.wire.records.values())
    assert len(h.wire.records)==5 and len(h.completed[0]['autoReviews'])==1


@pytest.mark.parametrize('stop',['expiry','cancel'])
def test_actual_publication_clamps_original_expiry_and_stops_before_new_task(tmp_path,stop):
    import auto_publish,sqlite3
    ctx,wire=context(tmp_path);ctx.update(adoption_age_seconds=3600,task_limit=51,deadline=wire.clock[0]+51*3600)
    expiry=wire.clock[0]+600;identity={'draftId':'draft','version':1,'publicationId':'publication'}
    image=photo(tmp_path)
    def tick(*args,bind_review,**kwargs):
        gateway=bind_review(identity,None,expiry)
        assert gateway('generated',[{'id':'p'}],[image],SCHEMA,tmp_path)=={'ok':True}
        return True
    env={'PHOTOSTORY_URL':'https://photo.invalid','PHOTOSTORY_BATCH_TOKEN':'synthetic','PHOTOSTORY_STATE_DIR':str(ctx['state_root'])}
    with patch.dict('os.environ',env,clear=True),patch.object(batch,'request',return_value=b'{}'),patch.object(auto_publish,'tick',side_effect=tick):
        batch.run(native_context=ctx)
        with sqlite3.connect(ctx['state_root']/'native.sqlite3') as db:value=json.loads(db.execute('SELECT value FROM native_operations').fetchone()[0])
        assert value['binding']['deadline']==expiry and value['binding']['task_limit']==1
        if stop=='expiry':wire.clock[0]=expiry
        else:ctx['cancel']=True
        count=len(wire.calls)
        with pytest.raises(batch.Stop):batch.run(native_context=ctx)
        assert len(wire.calls)==count


def test_new_task_age_policy_does_not_reinterpret_legacy_receipts(tmp_path):
    from native_tasks import NativeStopped
    ctx,wire=context(tmp_path)
    call=lambda:batch.native_review_gateway(ctx,stage='labels')('generated',[{'id':'p'}],[],SCHEMA,tmp_path)
    assert call()=={'ok':True}
    ctx.update(adoption_age_seconds=3600,task_limit=51)
    count=len(wire.calls)
    with pytest.raises(NativeStopped):call()
    assert len(wire.calls)==count
