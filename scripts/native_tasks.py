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
from urllib.parse import urlsplit

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


def _endpoint(value, synthetic, *, base=False):
    if (not isinstance(value,str) or not 1<=len(value)<=2000
            or any(c.isspace() or ord(c)<32 or ord(c)==127 for c in value)):
        raise ValueError()
    parsed=urlsplit(value)
    parsed.port  # Validate a supplied port before constructing any client.
    host=parsed.hostname or ''
    if (parsed.scheme!='https' or not host or parsed.username or parsed.password
            or parsed.query or parsed.fragment or (base and parsed.path not in {'','/'})):
        raise ValueError()
    if synthetic:
        if not host.endswith('.invalid'):raise ValueError()
    else:
        import ipaddress
        if (host=='localhost' or host.endswith(('.invalid','.test','.example','.localhost',
                                               '.example.com','.example.org','.example.net'))
                or host in {'example.com','example.org','example.net'}
                or 'configure' in host.lower() or 'placeholder' in host.lower()):
            raise ValueError()
        try:address=ipaddress.ip_address(host)
        except ValueError:pass
        else:
            if not address.is_global:raise ValueError()
    return value.rstrip('/') if base else value


def _context_fields(context):
    root, state = context['fixture_root'], context['state_root']
    if (type(context.get('synthetic_only')) is not bool or context['project'] != 'Pigbibi/PhotoStory'
            or type(context.get('cancel', False)) is not bool
            or not isinstance(context['operation_id'], str) or not 1 <= len(context['operation_id']) <= 200
            or not callable(context['now']) or not callable(context['persist'])
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

def validate_context(context):
    try:
        _context_fields(context)
        client=context['client']
        if not all(callable(getattr(client,name,None)) for name in ('submit','get','cancel')):
            raise ValueError()
        resource=_endpoint(client.resource,context['synthetic_only'],base=True)
        if resource!=client.resource:raise ValueError()
        if context['synthetic_only'] is False:
            # This explicit configuration detects drift; it grants no service permission.
            binding=context['native_binding']
            if (set(binding)!={'service_url','audience','project','routes','deadline'}
                    or binding['service_url']!=resource or binding['project']!=context['project']
                    or binding['routes']!=context['routes']
                    or type(binding['deadline']) not in (int,float) or not math.isfinite(binding['deadline'])
                    or not context['deadline']<=binding['deadline']):raise ValueError()
            _endpoint(binding['audience'],False)
    except (KeyError, TypeError, ValueError, OSError, AttributeError):
        raise NativeStopped('native_binding_required') from None


def bootstrap_context(binding, *, client_factory=None):
    """Build only an explicit caller binding; no environment discovery or task I/O."""
    try:
        if not isinstance(binding,dict) or binding.get('enabled') is not True:
            raise ValueError()
        required={'enabled','synthetic_only','project','operation_id','service_url','audience',
                  'routes','fixture_root','state_root','now','deadline','persist'}
        if not required<=set(binding) or set(binding)-required-{'cancel','limits'}:raise ValueError()
        context={k:v for k,v in binding.items() if k not in {'enabled','service_url','audience'}}
        context['routes']=json.loads(packed(binding['routes']))
        if 'limits' in context:context['limits']=json.loads(packed(context['limits']))
        _context_fields(context)
        if context['now']()>=context['deadline']:raise ValueError()
        resource=_endpoint(binding['service_url'],context['synthetic_only'],base=True)
        audience=_endpoint(binding['audience'],context['synthetic_only'])
        media_limits(context)
        if client_factory is not None and not callable(client_factory):raise ValueError()
    except (KeyError, TypeError, ValueError, OSError, AttributeError):
        raise NativeStopped('native_binding_required') from None
    if client_factory is None:
        try:
            from ai_service.client import TaskClient, github_token
        except ImportError:
            raise NativeStopped('native_sdk_unavailable') from None
        # The existing approved workload callback is lazy. Bootstrap obtains no token.
        client_factory=lambda base,aud:TaskClient(base,lambda:github_token(aud),max_response_bytes=2_000_000)
    try:context['client']=client_factory(resource,audience)
    except Exception:raise NativeStopped('native_sdk_unavailable') from None
    context['native_binding']={'service_url':resource,'audience':audience,'project':context['project'],
                             'routes':json.loads(packed(context['routes'])),'deadline':context['deadline']}
    validate_context(context)
    if context['client'].resource!=resource:raise NativeStopped('native_binding_required')
    return context



def _private_database(context):
    root = context['state_root']
    if not isinstance(root, Path) or root.resolve() != root or stat.S_IMODE(root.stat().st_mode) != 0o700:
        raise NativeStopped('native_input_or_state_unavailable')
    path = root/'native.sqlite3'
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise NativeStopped('native_input_or_state_unavailable')
    return path


def operation_context(context, operation_id, *, state_root=None, persist=None):
    """Attach the original business checkpoint and restore its frozen deadline."""
    result = {**context, 'operation_id':operation_id}
    if state_root is not None:
        state_root = Path(state_root)
        state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        result['state_root'] = state_root.resolve()
    if persist is not None:
        result['persist'] = persist
    path = _private_database(result)
    if not path.exists():
        return result
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_operations'").fetchone():
            return result
        rows = db.execute("SELECT value FROM native_operations WHERE json_extract(value,'$.binding.operation_id')=? LIMIT 1001", (operation_id,)).fetchall()
    if len(rows)>1000:
        raise NativeStopped('native_input_or_state_unavailable')
    deadlines = {json.loads(row[0])['binding']['deadline'] for row in rows}
    if deadlines:
        if len(deadlines)!=1 or any(type(v) not in (int,float) or not math.isfinite(v) for v in deadlines):
            raise NativeStopped('native_binding_changed')
        result['deadline'] = min(result['deadline'], deadlines.pop())
    return result


def media_limits(context):
    limits = context.get('limits', {})
    if not isinstance(limits, dict) or set(limits)-{'request_bytes','response_bytes'}:
        raise NativeStopped('native_size_contract')
    values = [limits.get(k,2_000_000) for k in ('request_bytes','response_bytes')]
    if any(type(v) is not int or not 1<=v<=2_000_000 for v in values):
        raise NativeStopped('native_size_contract')
    # GET echoes request+output. Reserve bounded output and record metadata;
    # this never raises the existing service/SDK2MB ceilings.
    return min(values[0],values[1]-196608), min(131072,values[1])


def _record_identity(value, record):
    binding, route = value['binding'], value['binding']['route']
    request_sha = digest(record['request']) if 'request' in record else record.get('request_sha256')
    if (record.get('owner') != binding['project'] or record.get('provider') != route['provider']
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
    if record.get('worker') is not None or record.get('attempt') is not None:
        claim = [record['worker'], record['attempt'], record['revision']]
        if (claim[0] != route['worker'] or not isinstance(claim[1], str) or not claim[1]
                or (value['claim'] and value['claim'] != claim)):
            raise ValueError()
        value['claim'] = claim
    elif value['claim']:
        raise ValueError()


def _completed_receipt(context, value, record, schema, output_limit):
    """Separate authoritative completion time from later advisory adoption."""
    _record_identity(value, record)
    now, created, completed = context['now'](), record.get('created'), record.get('updated')
    if (record.get('status') != 'completed' or not value['claim'] or value['cancel']
            or any(type(t) not in (int,float) or not math.isfinite(t) for t in (now,created,completed))
            or not 0 <= created <= completed <= now
            or completed >= min(value['binding']['deadline'], value['task_deadline'])
            or now >= value['binding']['deadline'] or context.get('cancel') is True
            or len(packed(record['output'])) > output_limit):
        raise ValueError()
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(record['output'])
    output_sha = digest(record['output'])
    if value['output_sha256'] and value['output_sha256'] != output_sha:
        raise ValueError()
    value.update(output_sha256=output_sha, accepted_output=json.loads(packed(record['output'])),
                 completed_at=completed, accepted_at=now)


def task_call(context, stage):
    """Use one generic submit/get/cancel task, never helper RPCs or CLI fallback."""
    def call(prompt, records, paths, schema, cwd):
        validate_context(context)
        if (stage not in STAGES or not isinstance(prompt, str) or len(prompt.encode()) > 128_000
                or not isinstance(records, list) or not 1 <= len(records) <= 24
                or not (len(paths) == len(records) or (stage == 'labels' and not paths))):
            raise NativeStopped('native_input_invalid')
        try:
            client, state_root = context['client'], context['state_root']
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
                               'base64': base64.b64encode(data).decode()})
            route = json.loads(packed(context['routes'][stage]))
            request = {'mode': route['mode'], 'model': route['model'], 'profile': route['profile'],
                       'objective': prompt, 'materials': [{'schema_version':'photostory.task-input.v1', 'stage': stage, 'records': records, 'images': images}],
                       'output_schema': schema, 'timeout_seconds': 60}
            request_limit, output_limit = media_limits(context)
            if len(packed(request)) > request_limit:
                raise ValueError()
            Draft202012Validator.check_schema(schema)
            request = json.loads(packed(request))
            operation = digest([context['operation_id'], stage, sorted(ids)])
            binding = {'project': context['project'], 'resource': context['client'].resource,
                       'operation_id': context['operation_id'], 'route': route,
                       'request_sha256': digest(request), 'deadline': context['deadline']}
            path = state_root/'native.sqlite3'
            # Lock a sidecar: locking the SQLite database itself conflicts with
            # SQLite's own file locks on macOS and would block archive/restore.
            fd = os.open(state_root/'native.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
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
                        directory = os.open(state_root, os.O_RDONLY | os.O_DIRECTORY)
                        try: os.fsync(directory)
                        finally: os.close(directory)
                        context['persist']()  # A failed checkpoint prevents the next POST.

                    def stop():
                        if value['task_id'] and not value['cancel'] and value.get('accepted_output') is None:
                            value['cancel'] = True
                            save()
                            try: client.cancel(value['task_id'])
                            except Exception: pass
                        value['halt'] = True
                        save()
                        raise NativeStopped('native_cancel_or_expiry')

                    def active(deadline=None):
                        if (context['project'] != binding['project'] or context['operation_id'] != binding['operation_id']
                                or context['client'] is not client or client.resource != binding['resource']
                                or context['state_root'] != state_root
                                or context['deadline'] != binding['deadline']
                                or context['routes'][stage] != route):
                            value['halt'] = True
                            save()
                            raise NativeStopped('native_binding_changed')
                        now = context['now']()
                        if (type(now) not in (int, float) or not math.isfinite(now)
                                or now >= min(binding['deadline'], deadline if deadline is not None else binding['deadline'])
                                or context.get('cancel') is True):
                            stop()

                    if value['halt'] or value['cancel'] or (value['intent'] and not value['task_id']):
                        raise NativeStopped('native_outcome_unknown')
                    if value.get('accepted_output') is not None:
                        active()  # A timely immutable receipt survives its old remote TTL.
                        cached = value['accepted_output']
                        if (not value['claim'] or digest(cached) != value['output_sha256']
                                or type(value.get('accepted_at')) not in (int,float)
                                or type(value.get('completed_at',value['accepted_at'])) not in (int,float)
                                or not 0 <= value.get('completed_at',value['accepted_at']) <= value['accepted_at'] < binding['deadline']
                                or not value.get('completed_at',value['accepted_at']) < value['task_deadline']
                                or len(packed(cached)) > output_limit):
                            raise NativeStopped('native_outcome_unknown')
                        Draft202012Validator(schema).validate(cached)
                        active()
                        return json.loads(packed(cached))
                    active()  # An expired execution TTL still permits one known-ID terminal read.
                    try:
                        if not value['task_id']:
                            value['intent'] = True
                            save()
                            active()
                            record = client.submit(request, 'photostory:'+operation)
                        else:
                            record = client.get(value['task_id'])
                        _record_identity(value, record)
                        if record['status'] != 'completed':
                            active(record['deadline'])
                        if record['status'] in {'queued', 'submitting', 'running'}:
                            if value['output_sha256']:
                                raise ValueError()
                            save()
                            raise NativePending('native_pending')
                        _completed_receipt(context, value, record, schema, output_limit)
                        save()
                        active()
                        return json.loads(packed(value['accepted_output']))
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


def publication_checkpoint(context):
    """Only the small operation ledger travels in the existing publication row."""
    path = _private_database(context)
    if not path.exists():
        return None
    with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_operations'").fetchone():
            return None
        rows = db.execute("SELECT operation,value FROM native_operations WHERE json_extract(value,'$.binding.operation_id')=? LIMIT 2", (context['operation_id'],)).fetchall()
    if not rows:
        return None
    if len(rows)!=1:
        raise NativeStopped('native_checkpoint_conflict')
    result = {'operation':rows[0][0], 'value':json.loads(rows[0][1])}
    if len(packed(result))>16384:
        raise NativeStopped('native_checkpoint_conflict')
    return result


def restore_publication_checkpoint(context, checkpoint):
    if checkpoint is None:
        return context
    try:
        if set(checkpoint)!={'operation','value'} or len(packed(checkpoint))>16384:
            raise ValueError()
        operation, value = checkpoint['operation'], checkpoint['value']
        binding = value['binding']
        if (not isinstance(operation,str) or len(operation)!=64 or any(c not in '0123456789abcdef' for c in operation)
                or binding['project']!=context['project'] or binding['resource']!=context['client'].resource
                or binding['operation_id']!=context['operation_id'] or binding['route']!=context['routes']['publication']
                or type(binding['deadline']) not in (int,float) or not math.isfinite(binding['deadline'])):
            raise ValueError()
        path = _private_database(context)
        descriptor = os.open(path, os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('CREATE TABLE IF NOT EXISTS native_operations (operation TEXT PRIMARY KEY, value TEXT NOT NULL)')
            old = db.execute('SELECT value FROM native_operations WHERE operation=?',(operation,)).fetchone()
            if old and json.loads(old[0])!=value:
                raise ValueError()
            db.execute('INSERT OR IGNORE INTO native_operations VALUES (?,?)',(operation,packed(value).decode()))
        return operation_context(context, context['operation_id'])
    except (KeyError,TypeError,ValueError,OSError,sqlite3.Error):
        raise NativeStopped('native_checkpoint_conflict') from None


def preflight_publication(context):
    """Read one known terminal receipt before another original image download."""
    validate_context(context)
    checkpoint = publication_checkpoint(context)
    if checkpoint is None:
        return
    value, client = checkpoint['value'], context['client']
    binding = value['binding']
    if value['halt'] or value['cancel'] or (value['intent'] and not value['task_id']):
        raise NativeStopped('native_outcome_unknown')

    def save():
        with sqlite3.connect(_private_database(context)) as db:
            db.execute('UPDATE native_operations SET value=? WHERE operation=?',(packed(value).decode(),checkpoint['operation']))
        context['persist']()

    def stop():
        if value['task_id'] and not value['cancel'] and value.get('accepted_output') is None:
            value['cancel'] = True
            save()
            try: client.cancel(value['task_id'])
            except Exception: pass
        value['halt'] = True
        save()
        raise NativeStopped('native_cancel_or_expiry')

    def active():
        if (context['project'] != binding['project'] or context['operation_id'] != binding['operation_id']
                or context['client'] is not client or client.resource != binding['resource']
                or context['routes']['publication'] != binding['route'] or context['deadline'] != binding['deadline']):
            value['halt'] = True
            save()
            raise NativeStopped('native_binding_changed')
        now = context['now']()
        if (type(now) not in (int,float) or not math.isfinite(now)
                or now >= binding['deadline'] or context.get('cancel') is True):
            stop()

    active()
    if (value.get('accepted_output') is not None or value['task_deadline'] is None
            or context['now']() < value['task_deadline']):
        return
    try:
        record = client.get(value['task_id'])
        _record_identity(value, record)
        if record['status'] == 'completed':
            # The original request digest binds this schema. Normal task_call
            # later rechecks the recreated inputs/schema before result adoption.
            _, output_limit = media_limits(context)
            _completed_receipt(context,value,record,record['request']['output_schema'],output_limit)
            active()
            save()
            active()
            return
    except NativeStopped:
        raise
    except Exception:
        value['halt'] = True
        save()
        raise NativeStopped('native_outcome_unavailable') from None
    stop()  # Still running/unknown past execution TTL: never adopt or resubmit.
