"""Private, checked SQLite snapshots for an ephemeral PhotoStory processor."""
import hashlib
import io
import json
import os
from contextlib import closing
from pathlib import Path
import re
import sqlite3
import tempfile
import urllib.parse
import urllib.request
import zipfile

MAX_ARCHIVE = 24 * 1024 * 1024
MAX_UNPACKED = 100 * 1024 * 1024
DB_NAME = re.compile(r"(?:processed|[A-Za-z0-9_-]{1,80})\.sqlite3\Z")
USER_AGENT = "PhotoStory/0.1 (+https://github.com/Pigbibi/PhotoStory)"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("inventory_redirect_blocked")


def opener(base):
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid_inventory_url")
    return urllib.request.build_opener(NoRedirect)


def archive(directory, job_id=None, source=None, policy=None, batch_id=None):
    directory = Path(directory)
    with tempfile.TemporaryDirectory(prefix="photostory-snapshot-") as tmp:
        snapshot = Path(tmp)
        size = 0
        for path in sorted(directory.glob("*.sqlite3")):
            if path.is_symlink() or not DB_NAME.fullmatch(path.name):
                raise ValueError("invalid_inventory_file")
            with closing(sqlite3.connect(path)) as source_db, closing(sqlite3.connect(snapshot / path.name)) as copy:
                source_db.backup(copy)
            size += (snapshot / path.name).stat().st_size
            if size > MAX_UNPACKED:
                raise ValueError("inventory_too_large")
        if batch_id:
            from inventory import Inventory

            copy = Inventory(snapshot, job_id, source, policy)
            try:
                if source.get("mode") == "history_match":
                    copy.reconcile_history(batch_id)
                else:
                    copy.reconcile(batch_id)
            finally:
                copy.close()
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(snapshot.glob("*.sqlite3")):
                bundle.write(path, path.name)
        if data.tell() > MAX_ARCHIVE:
            raise ValueError("inventory_too_large")
        return data.getvalue()


def restore(directory, data):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if len(data) > MAX_ARCHIVE or any(directory.iterdir()):
        raise ValueError("invalid_inventory_restore")
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        files = bundle.infolist()
        if len(files) > 100 or len({item.filename for item in files}) != len(files):
            raise ValueError("invalid_inventory_archive")
        if sum(item.file_size for item in files) > MAX_UNPACKED:
            raise ValueError("inventory_too_large")
        if any(not DB_NAME.fullmatch(item.filename) or item.is_dir() for item in files):
            raise ValueError("invalid_inventory_archive")
        with tempfile.TemporaryDirectory(prefix="photostory-restore-") as tmp:
            stage = Path(tmp)
            for item in files:
                path = stage / item.filename
                path.write_bytes(bundle.read(item))
                path.chmod(0o600)
                with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
                    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise ValueError("invalid_inventory_database")
            for path in stage.iterdir():
                path.replace(directory / path.name)


class CloudInventory:
    def __init__(self, base, token):
        self.opener = opener(base)
        self.url = base.rstrip("/") + "/internal/inventory"
        self.token = token

    def _request(self, method, *, data=None, job_id=None, lease=None, digest=None, seed=False):
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json",
                   "User-Agent": USER_AGENT}
        if job_id:
            headers["X-Job-Id"] = job_id
        if lease:
            headers["X-Job-Lease"] = lease
        if digest:
            headers["X-Inventory-Sha256"] = digest
            headers["Content-Type"] = "application/zip"
        if seed:
            headers["X-Inventory-Seed"] = "1"
        request = urllib.request.Request(self.url, data=data, headers=headers, method=method)
        with self.opener.open(request, timeout=90) as response:
            if response.status == 204:
                return None, None
            raw = response.read(MAX_ARCHIVE + 1)
            if len(raw) > MAX_ARCHIVE:
                raise ValueError("inventory_response_too_large")
            return raw, response.headers.get("X-Inventory-Sha256")

    def require_seed(self):
        request = urllib.request.Request(self.url + "/status", method="GET",
                                         headers={"Authorization": "Bearer " + self.token,
                                                  "User-Agent": USER_AGENT})
        with self.opener.open(request, timeout=45) as response:
            status = json.load(response)
        if status.get("ready") is not True:
            raise ValueError("inventory_seed_required")

    def load(self, directory, job_id, lease):
        raw, digest = self._request("GET", job_id=job_id, lease=lease)
        if raw is None:
            return False
        if not digest or hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("inventory_checksum_mismatch")
        restore(directory, raw)
        return True

    def save(self, directory, job_id, lease, source, policy, batch_id=None):
        raw = archive(directory, job_id, source, policy, batch_id)
        digest = hashlib.sha256(raw).hexdigest()
        reply, _ = self._request("PUT", data=raw, job_id=job_id, lease=lease, digest=digest)
        ref = json.loads(reply or b"{}").get("ref")
        if not isinstance(ref, str) or not re.fullmatch(r"[0-9a-f-]{36}", ref):
            raise ValueError("invalid_inventory_reference")
        return ref

    def seed(self, directory):
        raw = archive(directory)
        self._request("PUT", data=raw, digest=hashlib.sha256(raw).hexdigest(), seed=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["seed", "status"])
    parser.add_argument("--directory")
    args = parser.parse_args()
    client = CloudInventory(os.environ["PHOTOSTORY_URL"], os.environ["PHOTOSTORY_BATCH_TOKEN"])
    if args.command == "seed":
        if not args.directory or not Path(args.directory).is_absolute():
            parser.error("seed requires an absolute --directory")
        client.seed(args.directory)
        print("Cloudflare inventory seeded.")
    else:
        client.require_seed()
        print("Cloudflare inventory ready.")
