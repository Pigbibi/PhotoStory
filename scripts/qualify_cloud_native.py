"""Qualify one generated image through the current private native binding."""
import argparse
import base64
import json
import os
from pathlib import Path
import sqlite3
import time

from github_gateway import NativeTaskClient
from native_tasks import bootstrap_context, digest, NativePending, NativeStopped, task_call
from process_batch import workflow_binding
from smoke_gateway import IMAGE_BASE64, IMAGE_SHA256, SCHEMA


def run(root, *, environ=os.environ, sleep=time.sleep, now=time.time, client_factory=NativeTaskClient):
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
    persist()
    call=task_call(context,'screen')
    prompt='Generated color block qualification only. Return {"kind":"synthetic-test"}. No browsing, private photos, publishing, messages or external actions.'
    try:
        for _ in range(13):
            try:
                output=call(prompt,[{'id':'synthetic'}],[image.resolve()],SCHEMA,root)
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
        receipt=run(args.state)
    except Exception:
        print('{"phase":"unverified","reason":"read_original_receipt_do_not_rerun"}')
        return 1
    print(json.dumps(receipt,sort_keys=True));return 0


if __name__=='__main__':
    raise SystemExit(main())
