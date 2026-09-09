#!/usr/bin/env python3
"""Remove only stale PhotoStory temporary files; never touch OneDrive or the cache."""
import fcntl,json,os,shutil,stat,subprocess,tempfile,time
from pathlib import Path
from process_batch import request

def clean_targets(inbox,outbox,aihome,now):
    cutoff=now-86400
    counts={'files':0,'directories':0}
    files=[*inbox.glob('image-*.jpg'),*(inbox/name for name in ('prompt.txt','schema.json','request.json')),
           *(outbox/name for name in ('response.json','response.tmp'))]
    for path in files:
        try:info=path.lstat()
        except FileNotFoundError:continue
        if stat.S_ISREG(info.st_mode) and info.st_mtime<cutoff:
            path.unlink();counts['files']+=1
    if not shutil.rmtree.avoids_symlink_attacks:raise RuntimeError('safe_cleanup_unavailable')
    for path in aihome.glob('call-*'):
        info=path.lstat()
        if stat.S_ISDIR(info.st_mode) and info.st_mtime<cutoff:
            shutil.rmtree(path);counts['directories']+=1
    return counts

def idle():
    result=subprocess.run(['/usr/bin/systemctl','show','photostory-batch.service','photostory-ai.service','--property=ActiveState','--value'],capture_output=True,text=True,timeout=10)
    states=result.stdout.split()
    return result.returncode==0 and len(states)==2 and all(x in ('inactive','failed') for x in states)

def main():
    now=time.time();report={'at':int(now*1000),'status':'error','files':0,'directories':0}
    state=Path('/var/lib/photostory')
    try:
        base=os.environ['PHOTOSTORY_URL'].rstrip('/')
        policy=json.loads(request(base+'/internal/cleanup-policy',token=os.environ['PHOTOSTORY_BATCH_TOKEN']))
        if policy.get('enabled') is False:report['status']='disabled'
        elif policy.get('enabled') is not True:raise RuntimeError('policy_unavailable')
        elif not idle():report['status']='busy'
        else:
            # The scanner owns this existing lock. Never replace or recreate it.
            fd=os.open('/var/lib/photostory-bridge/input/client.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK)
            with os.fdopen(fd,'r+') as lock:
                try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:report['status']='busy'
                else:
                    if not idle():report['status']='busy'
                    else:
                        report.update(clean_targets(Path('/var/lib/photostory-bridge/input'),Path('/var/lib/photostory-bridge/output'),Path('/var/lib/photostory-ai'),now))
                        report['status']='ok'
    except Exception:
        report['status']='error' # No provider output, file names or credentials.
    with tempfile.NamedTemporaryFile(mode='w',dir=state,prefix='.cleanup-',delete=False) as f:
        json.dump(report,f);f.flush();os.fchmod(f.fileno(),0o640)
        os.fchown(f.fileno(),0,__import__('grp').getgrnam('photostory-bridge').gr_gid)
        name=f.name
    os.replace(name,state/'cleanup-status.json')
    print(json.dumps(report))
    return 1 if report['status']=='error' else 0

if __name__=='__main__':raise SystemExit(main())
