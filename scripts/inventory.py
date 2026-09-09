"""Private, resumable metadata inventory for one single-VPS deployment.

No image bytes, captions or OAuth tokens are stored here. SQLite commits each
Graph page and each acknowledged AI batch; unknown outcomes never replay AI.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import urllib.parse
import uuid


def event_batches(photos):
    groups=[]
    for photo in photos:
        split=not groups
        if groups:
            previous=groups[-1][-1]
            split=photo['taken']-previous['taken']>12*3600 or photo['taken']-groups[-1][0]['taken']>48*3600
            a,b=previous.get('area'),photo.get('area')
            if a and b:
                # Coarse coordinates are only a grouping hint, never a place name.
                lat1,lat2=map(math.radians,(a[0],b[0]))
                h=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b[1]-a[1])/2)**2
                split=split or 12742*math.asin(min(1,math.sqrt(h)))>30
        if split: groups.append([])
        groups[-1].append(photo)
    return groups


class Inventory:
    def __init__(self, directory, job_id, source, policy):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',job_id): raise ValueError('invalid_job_id')
        directory=Path(directory)
        directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        path=directory/(job_id+'.sqlite3')
        cache=directory/'processed.sqlite3'
        if not path.exists() and any((source.get('progress') or {}).get(k,0)>0 for k in ('total','processed','batches')):
            raise ValueError('local_state_missing')
        if path.is_symlink() or cache.is_symlink(): raise ValueError('invalid_state_path')
        self.db=sqlite3.connect(path)
        self.db.row_factory=sqlite3.Row
        path.chmod(0o600)
        self.db.execute('ATTACH DATABASE ? AS cache',(str(cache),))
        cache.chmod(0o600)
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,url TEXT,done INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS pages(hash TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,body TEXT NOT NULL,taken REAL NOT NULL,fingerprint TEXT,status TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS pending_photos ON photos(status,taken,id);
          CREATE TABLE IF NOT EXISTS cache.analyzed(fingerprint TEXT PRIMARY KEY,digest TEXT,policy TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS cache.digest_index ON analyzed(policy,digest);
        ''')
        self.source=source
        self.policy=policy
        signature=json.dumps({k:source.get(k) for k in ('folder','start','end')},sort_keys=True)+policy
        if self.get('signature') not in (None,signature): raise ValueError('source_changed')
        with self.db: self.set('signature',signature)

    def get(self,key):
        row=self.db.execute('SELECT value FROM meta WHERE key=?',(key,)).fetchone()
        return json.loads(row[0]) if row else None

    def set(self,key,value):
        self.db.execute('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,json.dumps(value)))

    def scan(self,graph,decode,page_budget=50):
        if not self.get('initialized'):
            path='/'.join(urllib.parse.quote(p,safe='') for p in self.source['folder'].split('/'))
            root=graph('https://graph.microsoft.com/v1.0/me/drive/root:/'+path)
            if 'folder' not in root or not root.get('id'): raise ValueError('folder_not_found')
            with self.db:
                self.db.execute('INSERT OR IGNORE INTO folders(id) VALUES(?)',(root['id'],))
                self.set('initialized',True)
        known=set(self.source.get('knownPhotoIds',[]))
        for _ in range(page_budget):
            folder=self.db.execute('SELECT * FROM folders WHERE done=0 ORDER BY rowid DESC LIMIT 1').fetchone()
            if not folder: return True
            url=folder['url'] or ('https://graph.microsoft.com/v1.0/me/drive/items/'+urllib.parse.quote(folder['id'],safe='')+'/children?$top=200')
            key=hashlib.sha256(url.encode()).hexdigest()
            if self.db.execute('SELECT 1 FROM pages WHERE hash=?',(key,)).fetchone(): raise ValueError('pagination_cycle')
            result=graph(url)
            following=result.get('@odata.nextLink')
            if following==url: raise ValueError('pagination_cycle')
            with self.db:
                for item in result.get('value',[]):
                    if 'remoteItem' in item: continue
                    if 'folder' in item:
                        self.db.execute('INSERT OR IGNORE INTO folders(id) VALUES(?)',(item['id'],))
                        continue
                    photo=decode(item)
                    if not photo: continue
                    fingerprint=photo.get('fingerprint')
                    if fingerprint: fingerprint=hashlib.sha256((self.policy+fingerprint).encode()).hexdigest()
                    photo['fingerprint']=fingerprint
                    cached=photo['id'] in known or (fingerprint and self.db.execute('SELECT 1 FROM cache.analyzed WHERE fingerprint=?',(fingerprint,)).fetchone())
                    self.db.execute('INSERT OR IGNORE INTO photos VALUES(?,?,?,?,?)',(photo['id'],json.dumps(photo),photo['taken'],fingerprint,'cached' if cached else 'pending'))
                self.db.execute('INSERT INTO pages VALUES(?)',(key,))
                self.db.execute('UPDATE folders SET url=?,done=? WHERE id=?',(following,0 if following else 1,folder['id']))
        return not self.db.execute('SELECT 1 FROM folders WHERE done=0 LIMIT 1').fetchone()

    def next_batch(self,limit):
        rows=self.db.execute("SELECT body FROM photos WHERE status='pending' ORDER BY taken,id LIMIT ?",(limit,)).fetchall()
        groups=event_batches([json.loads(row[0]) for row in rows])
        return groups[0] if groups else []

    def progress(self):
        row=self.db.execute("SELECT count(*) AS total,coalesce(sum(status!='pending'),0) AS processed FROM photos").fetchone()
        return {'phase':'scanning','total':row['total'],'processed':row['processed'],'batches':self.get('batches') or 0}

    def stage_batch(self,photos):
        if self.get('inflight'): raise ValueError('batch_outcome_unknown')
        batch_id=uuid.uuid4().hex
        with self.db: self.set('inflight',{'id':batch_id,'photos':photos,'digests':{}})
        return batch_id

    def save_digests(self,digests):
        batch=self.get('inflight')
        batch['digests']=digests
        with self.db: self.set('inflight',batch)

    def known_digest(self,digest):
        return bool(self.db.execute('SELECT 1 FROM cache.analyzed WHERE digest=? AND policy=? LIMIT 1',(digest,self.policy)).fetchone())

    def proposed_progress(self):
        progress=self.progress()
        progress['processed']+=len(self.get('inflight')['photos'])
        progress['batches']+=1
        progress['phase']='complete' if progress['processed']==progress['total'] else 'processing'
        return progress

    def reconcile(self,last_batch):
        batch=self.get('inflight')
        if not batch: return
        if batch['id']!=last_batch: raise ValueError('batch_outcome_unknown')
        with self.db:
            for photo in batch['photos']:
                self.db.execute("UPDATE photos SET status='done' WHERE id=?",(photo['id'],))
                if photo.get('fingerprint'):
                    self.db.execute('INSERT OR IGNORE INTO cache.analyzed VALUES(?,?,?)',(photo['fingerprint'],batch['digests'].get(photo['id']),self.policy))
            self.set('batches',(self.get('batches') or 0)+1)
            self.set('inflight',None)

    def close(self): self.db.close()
