"""Qualify one generated image through the current private native binding."""
import argparse
import base64
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time

from github_gateway import NativeTaskClient
from native_tasks import bootstrap_context, digest, NativePending, NativeStopped, task_call, _record_identity
from jsonschema import Draft202012Validator
from process_batch import workflow_binding
from smoke_gateway import IMAGE_BASE64, IMAGE_SHA256, SCHEMA

PROMPT = 'Generated color block qualification only. Return {"kind":"synthetic-test"}. No browsing, private photos, publishing, messages or external actions.'


def read_task(context, task_id):
    """Read the same synthetic task; never adopt late output or submit more work."""
    if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', task_id):
        raise NativeStopped('qualification_identity_changed')
    route = context['routes']['screen']
    request = {'mode': route['mode'], 'model': route['model'], 'profile': route['profile'],
               'objective': PROMPT, 'materials': [{'schema_version': 'photostory.task-input.v1',
                   'stage': 'screen', 'records': [{'id': 'synthetic'}], 'images': [
                       {'id': 'synthetic', 'mime': 'image/jpeg', 'sha256': IMAGE_SHA256,
                        'base64': IMAGE_BASE64}]}], 'output_schema': SCHEMA, 'timeout_seconds': 60}
    value = {'task_id': task_id, 'revision': 1, 'task_deadline': None, 'claim': None,
             'binding': {'project': context['project'], 'route': route,
                         'request_sha256': digest(request)}}
    record = context['client'].get(task_id)
    _record_identity(value, record)
    status = record.get('status')
    if status not in {'queued', 'submitting', 'running', 'outcome_unknown', 'cancel_requested',
                      'completed', 'failed', 'invalid_output', 'cancelled'}:
        raise NativeStopped('qualification_identity_changed')
    verified = status == 'completed'
    if verified:
        created, updated, deadline = (record.get(k) for k in ('created', 'updated', 'deadline'))
        if (not value['claim'] or any(type(t) not in (int, float) or not math.isfinite(t)
                                     for t in (created, updated, deadline))
                or not 0 <= created <= updated < deadline or updated > context['now']()):
            raise NativeStopped('qualification_identity_changed')
        Draft202012Validator(SCHEMA).validate(record.get('output'))
    return {'phase': 'completion_verified' if verified else 'unverified',
            'task_status': status, 'provider': route['provider'], 'adopted': False,
            'synthetic_only': True, 'business_access': False, 'read_only': True,
            'worker_claim_present': value['claim'] is not None}


def run(root, *, environ=os.environ, sleep=time.sleep, now=time.time, client_factory=NativeTaskClient,
        task_id=None):
    expected = {'GITHUB_REPOSITORY':'Pigbibi/PhotoStory', 'GITHUB_REF':'refs/heads/main',
                'GITHUB_WORKFLOW_REF':'Pigbibi/PhotoStory/.github/workflows/processor.yml@refs/heads/main',
                'GITHUB_EVENT_NAME':'workflow_dispatch', 'GITHUB_RUN_ATTEMPT':'1'}
    occurrence = environ.get('GITHUB_RUN_ID', '')
    if any(environ.get(k) != v for k,v in expected.items()) or not occurrence.isdecimal():
        raise NativeStopped('main_first_attempt_required')
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    state = root/'state';state.mkdir(mode=0o700)
    image = root/'generated.jpg';image.write_bytes(base64.b64decode(IMAGE_BASE64, validate=True))
    binding = workflow_binding(root.resolve(), state.resolve(), now=now)
    binding.update(operation_id='photostory-cloud-qualification:'+occurrence, task_limit=1,
                   deadline=now()+120)
    receipt = {'project':'Pigbibi/PhotoStory', 'occurrence':occurrence,
               'phase':'prepared', 'task_id':None, 'image_sha256':IMAGE_SHA256,
               'synthetic_only':True, 'business_access':False, 'adopted':False}

    def persist():
        database=state/'native.sqlite3'
        if database.exists():
            with sqlite3.connect(database) as db:
                rows=db.execute('SELECT value FROM native_operations').fetchall()
            if len(rows)!=1:raise NativeStopped('qualification_identity_changed')
            value=json.loads(rows[0][0])
            receipt.update(task_id=value['task_id'], request_sha256=value['binding']['request_sha256'])
            if receipt['phase'] in {'prepared','submitted','submission_unknown'}:
                receipt['phase']='submitted' if value['task_id'] else 'submission_unknown'
        target=root/'receipt.json';temporary=root/'receipt.tmp'
        temporary.write_text(json.dumps(receipt,sort_keys=True)+'\n');temporary.chmod(0o600)
        temporary.replace(target)

    binding['persist']=persist
    context=bootstrap_context(binding,client_factory=client_factory)
    if task_id is not None:
        result = read_task(context, task_id)
        (root/'receipt.json').write_text(json.dumps(result, sort_keys=True)+'\n')
        (root/'receipt.json').chmod(0o600)
        return result
    persist()
    call=task_call(context,'screen')
    try:
        for _ in range(13):
            try:
                output=call(PROMPT,[{'id':'synthetic'}],[image.resolve()],SCHEMA,root)
                receipt.update(phase='verified',adopted=True,output_sha256=digest(output))
                persist()
                return receipt
            except NativePending:
                sleep(5)
        raise NativeStopped('native_pending')
    except Exception:
        receipt['phase']='unverified';persist()
        raise NativeStopped('qualification_unverified_read_same_task') from None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state',type=Path,required=True)
    args=parser.parse_args()
    try:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        inputs = event.get('inputs', {})
        task_id = inputs.get('native_qualification_task_id', '')
        if task_id and inputs.get('native_qualification_action') != 'readback':
            raise NativeStopped('readback_required')
        receipt=run(args.state, task_id=task_id or None)
    except Exception:
        print('{"phase":"unverified","reason":"read_original_receipt_do_not_rerun"}')
        return 1
    print(json.dumps({k:receipt[k] for k in ('phase', 'task_status', 'provider', 'adopted',
        'synthetic_only', 'business_access', 'read_only', 'worker_claim_present') if k in receipt},sort_keys=True))
    return 0 if receipt['phase'] in {'verified', 'completion_verified'} else 1


if __name__=='__main__':
    raise SystemExit(main())
