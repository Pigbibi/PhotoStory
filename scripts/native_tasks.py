"""PhotoStory's single configured task per existing AI call, with private SQLite identity."""
import base64
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sqlite3
import stat

from jsonschema import Draft202012Validator
from PIL import Image

STAGES = {'screen', 'group', 'cross_review', 'labels', 'strict_review', 'publication'}


class NativeStopped(Exception):
    """The original operation cannot safely produce an adopted result."""


class NativePending(NativeStopped):
    """A known task is still running; retain the same identity for readback."""


def packed(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                      separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(packed(value)).hexdigest()


def validate_context(context):
    try:
        client = context['client']
        root, state = context['fixture_root'], context['state_root']
        if (context.get('synthetic_only') is not True or context['project'] != 'Pigbibi/PhotoStory'
                or type(context.get('cancel', False)) is not bool
                or not isinstance(context['operation_id'], str) or not 1 <= len(context['operation_id']) <= 200
                or not callable(context['now']) or not callable(context['persist'])
                or not all(callable(getattr(client, name, None)) for name in ('submit', 'get', 'cancel'))
                or not isinstance(client.resource, str) or not client.resource.startswith('https://')
                or not client.resource.endswith('.invalid')
                or set(context['routes']) != STAGES
                or not isinstance(root, Path) or root.resolve() != root or not root.is_dir()
                or not isinstance(state, Path) or state.resolve() != state or not state.is_dir()
                or stat.S_IMODE(state.stat().st_mode) != 0o700):
            raise ValueError()
        for value in (context['deadline'], context['now']()):
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError()
        for route in context['routes'].values():
            if (set(route) != {'mode', 'provider', 'model', 'profile', 'worker'}
                    or route['mode'] != 'agent' or route['provider'] not in {'dot', 'grok'}
                    or any(not isinstance(v, str) or not 1 <= len(v) <= 200 for v in route.values())):
                raise ValueError()
    except (KeyError, TypeError, ValueError, OSError, AttributeError):
        raise NativeStopped('native_binding_required') from None


def task_call(context, stage):
    """Use one generic submit/get/cancel task, never helper RPCs or CLI fallback."""
    def call(prompt, records, paths, schema, cwd):
        validate_context(context)
        if (stage not in STAGES or not isinstance(prompt, str) or len(prompt.encode()) > 128_000
                or not isinstance(records, list) or not 1 <= len(records) <= 24
                or not (len(paths) == len(records) or (stage == 'labels' and not paths))):
            raise NativeStopped('native_input_invalid')
        try:
            ids = [r['id'] for r in records]
            if any(not isinstance(v, str) or not 1 <= len(v) <= 200 for v in ids) or len(set(ids)) != len(ids):
                raise ValueError()
            images = []
            for record, path in zip(records, paths):
                if (not isinstance(path, Path) or path.is_symlink()
                        or not path.resolve().is_relative_to(context['fixture_root'])
                        or path.stat().st_size > 15_000_000):
                    raise ValueError()
                data = path.read_bytes()
                with Image.open(io.BytesIO(data)) as image:
                    if image.format != 'JPEG' or image.width*image.height > 50_000_000:
                        raise ValueError()
                images.append({'id': record['id'], 'mime': 'image/jpeg',
                               'sha256': hashlib.sha256(data).hexdigest(),
                               'synthetic_base64': base64.b64encode(data).decode()})
            route = json.loads(packed(context['routes'][stage]))
            request = {'mode': route['mode'], 'model': route['model'], 'profile': route['profile'],
                       'objective': prompt, 'materials': [{'stage': stage, 'records': records, 'images': images}],
                       'output_schema': schema, 'timeout_seconds': 60}
            if len(packed(request)) > 15_000_000:
                raise ValueError()
            Draft202012Validator.check_schema(schema)
            request = json.loads(packed(request))
            operation = digest([context['operation_id'], stage, sorted(ids)])
            binding = {'project': context['project'], 'resource': context['client'].resource,
                       'operation_id': context['operation_id'], 'route': route,
                       'request_sha256': digest(request), 'deadline': context['deadline']}
            path = context['state_root']/'native.sqlite3'
            # Lock a sidecar: locking the SQLite database itself conflicts with
            # SQLite's own file locks on macOS and would block archive/restore.
            fd = os.open(context['state_root']/'native.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'rb') as lock:
                info = os.fstat(lock.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
                    raise ValueError()
                fcntl.flock(lock, fcntl.LOCK_EX)
                check = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                try:
                    db_info = os.fstat(check)
                    if (not stat.S_ISREG(db_info.st_mode) or db_info.st_uid != os.getuid()
                            or db_info.st_nlink != 1 or stat.S_IMODE(db_info.st_mode) != 0o600):
                        raise ValueError()
                finally:
                    os.close(check)
                with sqlite3.connect(path) as db:
                    db.execute('PRAGMA synchronous=FULL')
                    db.execute('CREATE TABLE IF NOT EXISTS native_operations (operation TEXT PRIMARY KEY, value TEXT NOT NULL)')
                    row = db.execute('SELECT value FROM native_operations WHERE operation=?', (operation,)).fetchone()
                    value = json.loads(row[0]) if row else {'binding': binding, 'intent': False, 'task_id': None, 'revision': None, 'task_deadline': None, 'claim': None, 'output_sha256': None, 'halt': False, 'cancel': False}
                    if value['binding'] != binding:
                        raise NativeStopped('native_binding_changed')

                    def save():
                        db.execute('INSERT INTO native_operations VALUES (?,?) ON CONFLICT(operation) DO UPDATE SET value=excluded.value', (operation, packed(value).decode()))
                        db.commit()
                        directory = os.open(context['state_root'], os.O_RDONLY | os.O_DIRECTORY)
                        try: os.fsync(directory)
                        finally: os.close(directory)
                        context['persist']()  # A failed checkpoint prevents the next POST.

                    def stop():
                        if value['task_id'] and not value['cancel']:
                            value['cancel'] = True
                            save()
                            try: context['client'].cancel(value['task_id'])
                            except Exception: pass
                        value['halt'] = True
                        save()
                        raise NativeStopped('native_cancel_or_expiry')

                    def active(deadline=None):
                        if (context['project'] != binding['project'] or context['operation_id'] != binding['operation_id']
                                or context['client'].resource != binding['resource']
                                or context['routes'][stage] != route):
                            value['halt'] = True
                            save()
                            raise NativeStopped('native_binding_changed')
                        now = context['now']()
                        if (type(now) not in (int, float) or not math.isfinite(now)
                                or now >= min(context['deadline'], deadline if deadline is not None else context['deadline'])
                                or context.get('cancel') is True):
                            stop()

                    if value['halt'] or (value['intent'] and not value['task_id']):
                        raise NativeStopped('native_outcome_unknown')
                    active()
                    try:
                        if not value['task_id']:
                            value['intent'] = True
                            save()
                            active()
                            record = context['client'].submit(request, 'photostory:'+operation)
                        else:
                            record = context['client'].get(value['task_id'])
                        request_sha = digest(record['request']) if 'request' in record else record.get('request_sha256')
                        if (record.get('owner') != context['project'] or record.get('provider') != route['provider']
                                or not isinstance(record.get('id'), str) or not 1 <= len(record['id']) <= 200
                                or (value['task_id'] and value['task_id'] != record['id'])
                                or type(record.get('revision')) is not int or record['revision'] < 1
                                or (value['revision'] is not None and record['revision'] != value['revision'])
                                or request_sha != binding['request_sha256']
                                or type(record.get('deadline')) not in (int, float) or not math.isfinite(record['deadline'])
                                or (value['task_deadline'] is not None and record['deadline'] != value['task_deadline'])):
                            raise ValueError()
                        value['task_id'] = record['id']
                        value['revision'], value['task_deadline'] = record['revision'], record['deadline']
                        active(record['deadline'])
                        if record.get('worker') is not None or record.get('attempt') is not None:
                            claim = [record['worker'], record['attempt'], record['revision']]
                            if (claim[0] != route['worker'] or not isinstance(claim[1], str) or not claim[1]
                                    or (value['claim'] and value['claim'] != claim)):
                                raise ValueError()
                            value['claim'] = claim
                        elif value['claim']:
                            raise ValueError()
                        if record['status'] in {'queued', 'submitting', 'running'}:
                            if value['output_sha256']:
                                raise ValueError()
                            save()
                            raise NativePending('native_pending')
                        if record['status'] != 'completed' or not value['claim']:
                            raise ValueError()
                        Draft202012Validator(schema).validate(record['output'])
                        output_sha = digest(record['output'])
                        if value['output_sha256'] and value['output_sha256'] != output_sha:
                            raise ValueError()
                        value['output_sha256'] = output_sha
                        save()
                        active(record['deadline'])
                        return json.loads(packed(record['output']))
                    except NativePending:
                        raise
                    except NativeStopped:
                        raise
                    except Exception:
                        value['halt'] = True
                        save()
                        raise NativeStopped('native_outcome_unavailable') from None
        except NativeStopped:
            raise
        except Exception:
            raise NativeStopped('native_input_or_state_unavailable') from None
    return call
