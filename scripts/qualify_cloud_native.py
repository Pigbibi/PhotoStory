"""Qualify one configured stage with synthetic inputs and a bound task receipt."""
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
from native_tasks import (bootstrap_context, digest, NativePending, NativeStopped, task_call,
                          _record_identity, TASK_STATUSES, TASK_ERROR_CODES, ASYNC_SCREEN_PROFILES,
                          ASYNC_SCREEN_TIMEOUT, PROVIDER_PATTERN, STAGES, with_screen_route)
from jsonschema import Draft202012Validator
from process_batch import configured_project, workflow_binding, screen_binding
from smoke_gateway import IMAGE_BASE64, IMAGE_SHA256, SCHEMA

PROMPT = 'Generated color block qualification only. Return {"kind":"synthetic-test"}. No browsing, private photos, publishing, messages or external actions.'
SCREEN_PROMPT = ('Inspect the generated color block. Return a JSON object whose color field names the dominant RGB channel. '
                 'Use the attached image only. No browsing, publishing or external actions.')
SCREEN_SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['color'],
                 'properties': {'color': {'enum': ['red', 'green', 'blue']}}}
MUSE_PROMPT = SCREEN_PROMPT
MUSE_SCHEMA = SCREEN_SCHEMA
LEGACY_SMOKE_PROVIDERS = {'dot', 'grok', 'grokbot'}
FAILURE_REASONS = {'task_expired_before_claim', 'task_expired_after_claim',
                   'task_cancelled_before_claim', 'task_cancelled_after_claim',
                   'task_failed', 'task_invalid_output', 'task_outcome_unknown',
                   'task_pending', 'completion_rejected', 'qualification_unverified'}


def public_summary(receipt):
    """Project fixed codes and booleans only; never IDs, URLs or provider text."""
    result = {'phase': 'unverified'}
    choices = {'stage': STAGES, 'phase': {'verified', 'completion_verified', 'unverified'},
               'task_status': TASK_STATUSES | {'unknown'},
               'service_error_code': TASK_ERROR_CODES | {'unknown_error'},
               'failure_reason': FAILURE_REASONS}
    for key, allowed in choices.items():
        value = receipt.get(key)
        if isinstance(value, str) and value in allowed:
            result[key] = value
    provider = receipt.get('provider')
    if isinstance(provider, str) and PROVIDER_PATTERN.fullmatch(provider):
        result['provider'] = provider
    for key in ('adopted', 'synthetic_only', 'business_access', 'read_only',
                'worker_claim_present', 'caller_cancel_requested'):
        if type(receipt.get(key)) is bool:
            result[key] = receipt[key]
    return result


class QualificationUnverified(NativeStopped):
    def __init__(self, receipt):
        super().__init__('qualification_unverified_read_same_task')
        self.summary = public_summary(receipt)


def failure_reason(value, timestamp):
    status = value.get('task_status')
    claimed = value.get('claim') is not None
    expired = value.get('service_error_code') in {'deadline_before_submission', 'deadline_exceeded'}
    if status in {'queued', 'submitting', 'running', 'cancel_requested'}:
        deadline = value.get('task_deadline')
        expired = expired or (type(deadline) in (int, float) and timestamp >= deadline)
    if expired:
        return 'task_expired_after_claim' if claimed else 'task_expired_before_claim'
    if status == 'cancelled':
        return 'task_cancelled_after_claim' if claimed else 'task_cancelled_before_claim'
    return {'failed': 'task_failed', 'invalid_output': 'task_invalid_output',
            'outcome_unknown': 'task_outcome_unknown', 'completed': 'completion_rejected',
            'queued': 'task_pending', 'submitting': 'task_pending', 'running': 'task_pending',
            'cancel_requested': 'task_pending'}.get(status, 'qualification_unverified')


def _uses_business_contract(route, stage, *, business_stage=False):
    return business_stage or stage != 'screen' or route['provider'] not in LEGACY_SMOKE_PROVIDERS


def qualification_contract(context, stage='screen', *, business_stage=False):
    route = context['routes'][stage]
    records = [{'id': 'synthetic'}]
    if route['profile'] in ASYNC_SCREEN_PROFILES:
        return SCREEN_PROMPT, SCREEN_SCHEMA, ASYNC_SCREEN_TIMEOUT, records, True
    if not _uses_business_contract(route, stage, business_stage=business_stage):
        return PROMPT, SCHEMA, 60, records, True
    timeout = ASYNC_SCREEN_TIMEOUT if route['provider'] == 'muse' else 60
    from auto_review import SCHEMA as final_schema
    from cross_review import SCHEMA as cross_schema
    from process_batch import SCREEN_SCHEMA as batch_screen_schema, GROUP_SCHEMA
    from translate_labels import PROMPT as labels_prompt, SCHEMA as labels_schema
    prefix = 'Synthetic qualification only. No tools, publishing or external actions. '
    if stage == 'labels':
        return labels_prompt, labels_schema, timeout, [
            {'id': 'synthetic', 'title': 'Color sample', 'reason': 'A generated test image.'}], False
    if stage == 'screen':
        prompt = 'Screen the attached generated color block for outdoor scenery. Describe its dominant color in English.'
        schema = batch_screen_schema
    elif stage == 'group':
        prompt = 'Group only publishable outdoor scenery. Omit color calibration blocks from all drafts.'
        schema = GROUP_SCHEMA
    elif stage == 'cross_review':
        prompt = ('Review draft synthetic-draft with photo synthetic. Its caption claims a mountain view. '
                  'Correct unsupported claims and write an English alt naming the dominant visible color. '
                  'There are no reference drafts or other photographs.')
        schema = cross_schema
        records[0]['draftId'] = 'synthetic-draft'
    else:
        prompt = ('Review this proposed outdoor travel post depicting a mountain peak. '
                  'If its image does not support that caption, require human review.')
        schema = final_schema
    return prefix + prompt, schema, timeout, records, True


def check_fixture(stage, route, output, *, business_stage=False):
    if route['profile'] in ASYNC_SCREEN_PROFILES:
        if output != {'color': 'blue'}:
            raise NativeStopped('qualification_fixture_result')
        return
    if not _uses_business_contract(route, stage, business_stage=business_stage):
        return
    if stage == 'screen':
        photos = output['photos']
        ok = (len(photos) == 1 and photos[0]['id'] == 'synthetic' and photos[0]['decision'] != 'allow'
              and not photos[0]['landscape'] and 'blue' in photos[0]['description'].lower())
    elif stage == 'group':
        ok = output == {'drafts': []}
    elif stage == 'cross_review':
        checks = output['checks']
        photos = checks[0]['copy']['photos'] if len(checks) == 1 else []
        ok = (len(checks) == 1 and checks[0]['draftId'] == 'synthetic-draft' and not checks[0]['duplicateIds']
              and len(photos) == 1 and photos[0]['id'] == 'synthetic' and 'blue' in photos[0]['alt'].lower())
    elif stage == 'labels':
        labels = output['labels']
        ok = (len(labels) == 1 and labels[0]['id'] == 'synthetic' and
              all(entry['title'].strip() and entry['reason'].strip() for entry in labels[0]['translations'].values()))
    else:
        ok = output['needsHumanReview'] and not output['captionGrounded']
    if not ok:
        raise NativeStopped('qualification_fixture_result')


def read_task(context, task_id, stage='screen', *, business_stage=False):
    """Read the same synthetic task; never adopt late output or submit more work."""
    if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', task_id):
        raise NativeStopped('qualification_identity_changed')
    route = context['routes'][stage]
    prompt, schema, timeout, records, has_image = qualification_contract(
        context, stage, business_stage=business_stage)
    images = [{'id': 'synthetic', 'mime': 'image/jpeg', 'sha256': IMAGE_SHA256,
               'base64': IMAGE_BASE64}] if has_image else []
    request = {'mode': route['mode'], 'model': route['model'], 'profile': route['profile'],
               'objective': prompt, 'materials': [{'schema_version': 'photostory.task-input.v1',
                   'stage': stage, 'records': records, 'images': images}],
               'output_schema': schema, 'timeout_seconds': timeout}
    value = {'task_id': task_id, 'revision': 1, 'task_deadline': None, 'claim': None,
             'binding': {'project': context['project'], 'route': route,
                         'request_sha256': digest(request)}}
    record = context['client'].get(task_id)
    _record_identity(value, record)
    status = record.get('status')
    if not isinstance(status, str) or status not in TASK_STATUSES:
        raise NativeStopped('qualification_identity_changed')
    verified = status == 'completed'
    if verified:
        created, updated, deadline = (record.get(k) for k in ('created', 'updated', 'deadline'))
        if (not value['claim'] or any(type(t) not in (int, float) or not math.isfinite(t)
                                     for t in (created, updated, deadline))
                or not 0 <= created <= updated < deadline or updated > context['now']()):
            raise NativeStopped('qualification_identity_changed')
        Draft202012Validator(schema).validate(record.get('output'))
        check_fixture(stage, route, record['output'], business_stage=business_stage)
    result = {'stage': stage, 'phase': 'completion_verified' if verified else 'unverified',
              'task_status': status, 'provider': route['provider'], 'adopted': False,
              'synthetic_only': True, 'business_access': False, 'read_only': True,
              'worker_claim_present': value['claim'] is not None}
    if not verified:
        error = record.get('error')
        value.update(task_status=status, service_error_code=error if isinstance(error, str)
                     and error in TASK_ERROR_CODES else None if error is None else 'unknown_error')
        result.update(failure_reason=failure_reason(value, context['now']()),
                      service_error_code=value['service_error_code'])
    return result


def run(root, *, environ=os.environ, sleep=time.sleep, now=time.time, client_factory=NativeTaskClient,
        task_id=None, use_screen_route=False, use_muse=False, stage='screen',
        business_stage=False, require_muse=False):
    project = configured_project(environ)
    expected = {'GITHUB_REPOSITORY': project, 'GITHUB_REF': 'refs/heads/main',
                'GITHUB_WORKFLOW_REF': f'{project}/.github/workflows/processor.yml@refs/heads/main',
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ATTEMPT': '1'}
    occurrence = environ.get('GITHUB_RUN_ID', '')
    if any(environ.get(k) != v for k, v in expected.items()) or not occurrence.isdecimal():
        raise NativeStopped('main_first_attempt_required')
    use_async_screen = use_screen_route or use_muse
    use_business = business_stage or require_muse
    if stage not in STAGES or (use_async_screen and stage != 'screen'):
        raise NativeStopped('qualification_stage_invalid')
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    state = root / 'state'; state.mkdir(mode=0o700)
    image = root / 'generated.jpg'; image.write_bytes(base64.b64decode(IMAGE_BASE64, validate=True))
    binding = workflow_binding(root.resolve(), state.resolve(), now=now, environ=environ)
    if use_async_screen:
        pilot = screen_binding(environ=environ)
        if not pilot:
            raise NativeStopped('native_binding_required')
        binding = with_screen_route(binding, pilot['route'])
    route = binding['routes'][stage]
    binding.update(operation_id='photostory-cloud-qualification:'+occurrence, task_limit=1,
                   deadline=now()+(ASYNC_SCREEN_TIMEOUT+30 if (use_async_screen or route['provider'] == 'muse') else 120))
    receipt = {'project': project, 'occurrence': occurrence,
               'phase': 'prepared', 'task_id': None, 'image_sha256': IMAGE_SHA256,
               'synthetic_only': True, 'business_access': False, 'adopted': False,
               'provider': route['provider'], 'stage': stage}

    def persist():
        database=state/'native.sqlite3'
        if database.exists():
            with sqlite3.connect(database) as db:
                rows=db.execute('SELECT value FROM native_operations').fetchall()
            if len(rows)!=1:raise NativeStopped('qualification_identity_changed')
            value=json.loads(rows[0][0])
            receipt.update(task_id=value['task_id'], request_sha256=value['binding']['request_sha256'])
            receipt.update(worker_claim_present=value['claim'] is not None,
                           caller_cancel_requested=value['cancel'])
            for key in ('task_status', 'service_error_code'):
                if key in value:receipt[key]=value[key]
            if receipt['phase']=='unverified':
                receipt['failure_reason']=failure_reason(value, now())
            if receipt['phase'] in {'prepared','submitted','submission_unknown'}:
                receipt['phase']='submitted' if value['task_id'] else 'submission_unknown'
        target=root/'receipt.json';temporary=root/'receipt.tmp'
        temporary.write_text(json.dumps(receipt,sort_keys=True)+'\n');temporary.chmod(0o600)
        temporary.replace(target)

    binding['persist']=persist
    context=bootstrap_context(binding,client_factory=client_factory)
    prompt, schema, timeout, records, has_image = qualification_contract(
        context, stage, business_stage=use_business)
    if task_id is not None:
        result = read_task(context, task_id, stage, business_stage=use_business)
        (root/'receipt.json').write_text(json.dumps(result, sort_keys=True)+'\n')
        (root/'receipt.json').chmod(0o600)
        return result
    persist()
    call=task_call(context,stage)
    try:
        for _ in range(timeout // 5 + 1):
            try:
                output=call(prompt,records,[image.resolve()] if has_image else [],schema,root)
                check_fixture(stage, route, output, business_stage=use_business)
                receipt.update(phase='verified',adopted=True,output_sha256=digest(output))
                persist()
                return receipt
            except NativePending:
                sleep(5)
        raise NativeStopped('native_pending')
    except Exception:
        receipt['phase']='unverified';persist()
        raise QualificationUnverified(receipt) from None


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
        use_screen_route = (inputs.get('qualify_screen_route') in (True, 'true')
                            or inputs.get('qualify_muse_screen') in (True, 'true'))
        requested = inputs.get('qualification_stage') or 'screen'
        stage = os.environ.get('QUALIFICATION_STAGE') or 'screen'
        if requested not in {*STAGES, 'all'} or (requested != 'all' and requested != stage):
            raise NativeStopped('qualification_stage_invalid')
        if requested == 'all' and (task_id or use_screen_route):
            raise NativeStopped('qualification_stage_invalid')
        receipt=run(args.state, task_id=task_id or None, use_screen_route=use_screen_route,
                    stage=stage, business_stage=requested == 'all' or stage != 'screen')
    except QualificationUnverified as error:
        print(json.dumps(error.summary, sort_keys=True))
        return 1
    except Exception:
        print('{"phase":"unverified","reason":"read_original_receipt_do_not_rerun"}')
        return 1
    print(json.dumps(public_summary(receipt),sort_keys=True))
    return 0 if receipt['phase'] in {'verified', 'completion_verified'} else 1


if __name__=='__main__':
    raise SystemExit(main())
