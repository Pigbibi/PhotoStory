#!/usr/bin/env python3
"""AIGateway-compatible client for the separate PhotoStory AI systemd service."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import uuid

BRIDGE = Path('/var/lib/photostory-bridge')


def read_regular(path, limit):
    import stat
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('invalid_file')
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise ValueError('file_too_large')
    return value


def parse_args():
    parser = argparse.ArgumentParser()
    for name in ('prompt-file', 'output-schema', 'out', 'cwd'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--image', action='append', default=[])
    parser.add_argument('--providers', choices=['codex'], required=True)
    parser.add_argument('--sandbox', choices=['read-only'], required=True)
    parser.add_argument('--ask-for-approval', choices=['never'], required=True)
    parser.add_argument('--complexity', choices=['medium'], required=True)
    parser.add_argument('--timeout-seconds', choices=['600'], required=True)
    return parser.parse_args()


def main():
    os.umask(0o027)
    args = parse_args()
    if not 1 <= len(args.image) <= 24:
        raise ValueError('invalid_image_count')
    # Serialize the fixed mailbox and reject contention instead of replaying work.
    with (BRIDGE / 'input' / 'client.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        request_id = str(uuid.uuid4())
        files = {'prompt.txt': read_regular(args.prompt_file, 128_000),
                 'schema.json': read_regular(args.output_schema, 64_000)}
        for i, path in enumerate(args.image):
            data = read_regular(path, 512_000)
            if not data.startswith(b'\xff\xd8\xff'):
                raise ValueError('invalid_jpeg')
            files[f'image-{i}.jpg'] = data
        inbox = BRIDGE / 'input'
        for old in inbox.glob('image-*.jpg'):
            old.unlink()
        try:
            for name, data in files.items():
                (inbox / name).write_bytes(data)
            (inbox / 'request.json').write_text(json.dumps({'id': request_id, 'images': len(args.image)}))
            result = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'start', 'photostory-ai.service'],
                                    capture_output=True, timeout=650)
            if result.returncode:
                raise ValueError('isolated_service_failed')
            reply = json.loads(read_regular(BRIDGE / 'output' / 'response.json', 110_000))
            if reply.get('id') != request_id or not isinstance(reply.get('body'), dict):
                raise ValueError('invalid_response')
            Path(args.out).write_text(json.dumps(reply['body']))
        finally:
            for name in (*files, 'request.json'):
                (inbox / name).unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('PhotoStory isolated AI call failed.')
        raise SystemExit(1) from None
