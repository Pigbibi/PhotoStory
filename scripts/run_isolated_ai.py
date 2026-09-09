#!/usr/bin/env python3
"""Fixed, unprivileged AI service. No browser, Graph, or machine credentials."""
import json
import base64
import time
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import tempfile
import uuid
from systemd_gateway import read_regular

BRIDGE = Path('/var/lib/photostory-bridge')
STAGE = 'input'


def access_snapshot(source):
    """Reuse current access only; never let a second client rotate shared refresh tokens."""
    tokens = source.get('tokens') or {}
    access = tokens.get('access_token', '')
    claims = json.loads(base64.urlsafe_b64decode(access.split('.')[1] + '=='))
    if claims.get('exp', 0) <= time.time() + 650:
        raise ValueError('existing_auth_expiring')
    if not all(isinstance(tokens.get(k), str) and tokens[k] for k in ('access_token', 'id_token')):
        raise ValueError('invalid_existing_auth')
    return {'auth_mode': 'chatgpt', 'OPENAI_API_KEY': None,
            'tokens': {**{k: tokens.get(k) for k in ('access_token', 'id_token', 'account_id')},
                       'refresh_token': ''},
            'last_refresh': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}


def command_for(mode, work, count):
    if mode == 'codex-cli':
        args = ['/opt/photostory/app/runtime/bin/codex', 'exec',
                '--skip-git-repo-check', '--sandbox', 'read-only',
                '--output-schema', str(work / 'schema.json'),
                '--output-last-message', str(work / 'result.json'), '-C', str(work)]
        for i in range(count):
            args += ['--image', str(work / f'image-{i}.jpg')]
        if os.environ.get('PHOTOSTORY_CODEX_MODEL'):
            args += ['--model', os.environ['PHOTOSTORY_CODEX_MODEL']]
        return args + ['-']
    if mode != 'aigateway-cli':
        raise ValueError('invalid_ai_mode')
    args = [os.environ.get('PHOTOSTORY_GATEWAY_PATH', '/opt/codex-gateway/bin/codex-gateway'), '--prompt-file', str(work / 'prompt.txt'),
            '--output-schema', str(work / 'schema.json'), '--out', str(work / 'result.json'),
            '--providers', 'codex', '--sandbox', 'read-only', '--ask-for-approval', 'never',
            '--complexity', 'medium', '--timeout-seconds', '600', '--cwd', str(work)]
    for i in range(count):
        args += ['--image', str(work / f'image-{i}.jpg')]
    return args


def main():
    global STAGE
    os.umask(0o027)
    inbox, outbox = BRIDGE / 'input', BRIDGE / 'output'
    (outbox / 'response.json').unlink(missing_ok=True)
    request = json.loads(read_regular(inbox / 'request.json', 1024))
    request_id, count = request['id'], request['images']
    if str(uuid.UUID(request_id)) != request_id or type(count) is not int or not 0 <= count <= 24:
        raise ValueError('invalid_request')
    # Copy bounded regular inputs into AI-owned storage before the model sees them.
    with tempfile.TemporaryDirectory(prefix='call-', dir='/var/lib/photostory-ai') as tmp:
        work = Path(tmp)
        for name, limit in [('prompt.txt', 128_000), ('schema.json', 64_000)] + [(f'image-{i}.jpg', 512_000) for i in range(count)]:
            (work / name).write_bytes(read_regular(inbox / name, limit))
        STAGE = 'authentication'
        codex_home = '/var/lib/photostory-ai/codex'
        credential_dir = os.environ.get('CREDENTIALS_DIRECTORY')
        if credential_dir:
            # systemd consumes the existing owner's auth; no persistent duplicate is made.
            snapshot = access_snapshot(json.loads(read_regular(Path(credential_dir) / 'codex-auth', 64_000)))
            private_auth = work / 'codex-auth'
            private_auth.mkdir(mode=0o700)
            auth_path = private_auth / 'auth.json'
            auth_path.write_text(json.dumps(snapshot))
            auth_path.chmod(0o600)
            codex_home = str(private_auth)
        mode = os.environ.get('PHOTOSTORY_AI_MODE', 'codex-cli')
        args = command_for(mode, work, count)
        env = {'PATH': '/opt/photostory/app/runtime/bin:/usr/local/bin:/usr/bin:/bin',
               'HOME': '/var/lib/photostory-ai', 'CODEX_HOME': codex_home,
               'LANG': 'C.UTF-8', 'CODEX_GATEWAY_BACKEND': 'local',
               'CODEX_GATEWAY_AUTO_INSTALL_CODEX': 'false', 'CODEX_GATEWAY_PROVIDER_CHAIN': 'codex',
               'CODEX_GATEWAY_PROVIDER_MAX_ATTEMPTS': '1'}
        if os.environ.get('PHOTOSTORY_CODEX_MODEL'):
            env['CODEX_GATEWAY_MODEL'] = os.environ['PHOTOSTORY_CODEX_MODEL']
        STAGE = 'gateway'
        result = subprocess.run(args, cwd=work, env=env,
                                input=read_regular(work / 'prompt.txt', 128_000) if mode == 'codex-cli' else None,
                                capture_output=True, timeout=620)
        if result.returncode:
            message = (result.stdout + result.stderr).decode('utf-8', errors='replace').lower()
            for marker, stage in [('unknown feature', 'unsupported_feature'), ('unexpected argument', 'unsupported_argument'),
                                  ('unauthorized', 'authentication_rejected'), ('401', 'authentication_rejected'),
                                  ('certificate', 'tls'), ('permission denied', 'permissions'),
                                  ('no such file', 'missing_runtime_file'), ('usage limit', 'quota')]:
                if marker in message:
                    STAGE = stage
                    break
            raise ValueError('gateway_failed')
        STAGE = 'result'
        body = json.loads(read_regular(work / 'result.json', 100_000))
        if not isinstance(body, dict):
            raise ValueError('invalid_result')
        response = outbox / 'response.tmp'
        response.write_text(json.dumps({'id': request_id, 'body': body}))
        response.replace(outbox / 'response.json')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Only fixed stage and exception type; never provider text or prompt content.
        print(json.dumps({'stage': STAGE, 'class': type(exc).__name__}), flush=True)
        raise SystemExit(1) from None
