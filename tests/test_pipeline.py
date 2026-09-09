import sys,json,tempfile,unittest,io,contextlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
import process_batch as b

class PipelineTests(unittest.TestCase):
    def test_large_range_exclusions_and_lost_ack_never_repeat_completed_ai(self):
        config={'pipeline':2,'folder':'Photos','start':None,'end':None,'maxPhotos':100,'knownPhotoIds':[],'accessToken':'dummy'}
        remote={'id':'job','status':'pending','progress':{'phase':'scanning','total':0,'processed':0,'batches':0}}
        seen=[]; commits=[]; lose_ack=[True]
        def request(url,**kwargs):
            body=kwargs['body']; endpoint=url.rsplit('/',1)[-1]
            if endpoint=='claim':
                if remote['status']!='pending': return b'null'
                remote['status']='running'; result={'id':remote['id'],'lease':'lease'}
            elif endpoint=='source': result={**config,**remote}
            elif endpoint=='checkpoint':
                remote.update(progress=body['progress'],status='pending');result={'ok':True}
            elif endpoint=='complete':
                self.assertEqual(body['drafts'],[]); self.assertEqual(body['photos'],[])
                commits.append(body['batchId'])
                remote.update(progress=body['progress'],lastBatch=body['batchId'],status='pending' if body['more'] else 'complete')
                if lose_ack[0]: lose_ack[0]=False;raise OSError('lost transport')
                result={'count':0}
            else: raise AssertionError('Unexpected endpoint: '+endpoint)
            return json.dumps(result).encode()
        def record(i): return {'id':str(i),'parentReference':{'driveId':'drive'},'image':{},'photo':{'takenDateTime':'2026-08-20T00:00:00Z'},'eTag':'v1'}
        def graph(url,token):
            if '/root:/' in url:return {'id':'root','folder':{}}
            if url.endswith('/next'):return {'value':[record(i) for i in range(200,250)]}
            return {'value':[record(i) for i in range(200)],'@odata.nextLink':'https://graph.microsoft.com/next'}
        def gateway(prompt,records,*args):
            seen.extend(p['id'] for p in records)
            return {'photos':[{'id':p['id'],'decision':'exclude','flags':['uncertain'],'landscape':False,'aesthetic':0,'description':''} for p in records]}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(b.os.environ,{'PHOTOSTORY_URL':'https://example.test','PHOTOSTORY_BATCH_TOKEN':'dummy','CODEX_GATEWAY_COMMAND':'/unused','PHOTOSTORY_STATE_DIR':tmp},clear=True),patch.object(b,'request',side_effect=request),patch.object(b,'graph',side_effect=graph),patch.object(b,'gateway',side_effect=gateway),patch.object(b,'thumbnail',side_effect=lambda p,t:b'\xff\xd8\xff'+p['id'].encode()),contextlib.redirect_stdout(io.StringIO()):
            b.run() # Entire metadata range discovered before AI.
            self.assertEqual(seen,[])
            with self.assertRaises(b.Stop): b.run() # Server commits, client loses acknowledgement.
            self.assertEqual(remote['status'],'pending')
            while remote['status']=='pending':b.run()
            self.assertEqual(len(seen),250);self.assertEqual(len(set(seen)),250)
            self.assertEqual(len(commits),3)
            self.assertEqual(remote['progress']['processed'],250)
            remote.clear();remote.update(id='overlap',status='pending',progress={'phase':'scanning','total':0,'processed':0,'batches':0})
            while remote['status']=='pending':b.run()
            self.assertEqual(len(seen),250) # Even excluded versions are remembered.

if __name__=='__main__': unittest.main()
