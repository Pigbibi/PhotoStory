"""Fill private travel hints on already-approved drafts without scanning photos."""
import json
import os
import urllib.request
from cloud_inventory import USER_AGENT


def main():
    base=os.environ['PHOTOSTORY_URL'].rstrip('/')
    token=os.environ['PHOTOSTORY_BATCH_TOKEN']
    if not base.startswith('https://') or not token:
        raise ValueError('setup_required')
    cursor=None
    updated=skipped=0
    for _ in range(20):
        body=json.dumps({'cursor':cursor}).encode()
        request=urllib.request.Request(base+'/internal/travel-backfill',data=body,
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':USER_AGENT},method='POST')
        with urllib.request.urlopen(request,timeout=150) as response:
            result=json.load(response)
        if not isinstance(result,dict) or not all(type(result.get(k)) is int for k in ('updated','skipped')) or type(result.get('done')) is not bool:
            raise ValueError('invalid_backfill_result')
        updated+=result['updated'];skipped+=result['skipped']
        if result['done']:
            print('Travel hints updated:',updated,'unavailable:',skipped)
            return
        if not isinstance(result.get('next'),str) or result['next']==cursor:
            raise ValueError('invalid_backfill_cursor')
        cursor=result['next']
    raise ValueError('backfill_page_limit')


if __name__=='__main__':
    main()
