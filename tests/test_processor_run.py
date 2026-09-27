"""Exercise the real batch wiring with local JPEGs and no external calls."""
import io,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import process_batch as b
from cross_review import SCHEMA as CROSS_SCHEMA

def cross_checks(prompt):
 drafts=json.loads(prompt.split('Post data:\n',1)[1])['drafts']
 return {'checks':[{'draftId':d['id'],'duplicateIds':[],'captionGrounded':True,'locationGrounded':True,
                    'copy':{**{k:d[k] for k in ('title','caption','hashtags','reason')},
                            'photos':[{k:p[k] for k in ('id','alt')} for p in d['photos']]}} for d in drafts]}

class ProcessorRunTests(unittest.TestCase):
 def test_screened_pixels_reach_grouping_and_saved_crop(self):
  data=io.BytesIO();Image.new('RGB',(800,600),'blue').save(data,'JPEG')
  photo={'id':'p','captured':'2026-08-18T10:00:00+08:00','taken':1000,'area':[22.1,113.5]}
  safe={'id':'p','decision':'allow','flags':[],'landscape':True,'aesthetic':8,'description':'Coast','peopleRole':'none','compositionClear':True,'contentKind':'permanent_scenery',
        'light':'day','scene':'architecture','place':{'city':'Macau','landmark':'The Parisian Macao','evidence':'public landmark','confidence':'high'}}
  inv=MagicMock();inv.scan.return_value=True;inv.next_batch.return_value=[photo]
  inv.stage_batch.return_value='batch';inv.known_digest.return_value=False
  inv.progress.return_value={'total':1,'processed':0,'analyzed':0}
  inv.proposed_progress.return_value={'phase':'processing','total':1,'processed':1,'analyzed':1,'batches':1}
  completed=[]
  def request(url,**kwargs):
   if url.endswith('/internal/claim'): result={'id':'job','lease':'test-lease'}
   elif url.endswith('/internal/source'): result={'pipeline':2,'progress':{'phase':'processing'},'maxPhotos':20,'draftLimit':6,'accessToken':'test-token'}
   elif url.endswith('/internal/complete'):
    completed.append(kwargs['body']);result={'count':len(kwargs['body']['drafts'])}
   else:result={}
   return json.dumps(result).encode()
  def gateway(prompt,records,paths,schema,cwd):
   if schema==b.SCREEN_SCHEMA:
    self.assertEqual(records[0]['area'],[22.1,113.5])
    return {'photos':[safe]}
   if schema==CROSS_SCHEMA:return cross_checks(prompt)
   self.assertEqual([p['id'] for p in records],['p'])
   self.assertEqual(records[0]['light'],'day');self.assertEqual(records[0]['scene'],'architecture');self.assertEqual(records[0]['place']['city'],'Macau')
   self.assertIn('Target aspect: 3:2',prompt)
   self.assertIn('Return at most 6 drafts.',prompt)
   return {'drafts':[{'title':'Coast','caption':'A coast.','hashtags':'#Coast','reason':'Theme','photos':[{'id':'p','alt':'Coast','frame':{'mode':'crop','x':50,'y':20}}]}]}
  with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'PHOTOSTORY_URL':'https://example.invalid','PHOTOSTORY_BATCH_TOKEN':'test-token','CODEX_GATEWAY_COMMAND':'test-gateway','PHOTOSTORY_STATE_DIR':tmp}),patch('inventory.Inventory',return_value=inv),patch.object(b,'request',side_effect=request),patch.object(b,'thumbnail',return_value=data.getvalue()),patch.object(b,'gateway',side_effect=gateway),patch('translate_labels.translate_labels',side_effect=lambda drafts,*args:drafts):
   b.run()
  self.assertEqual(len(completed),1)
  draft=completed[0]['drafts'][0]
  self.assertEqual(draft['aspect'],'3:2')
  self.assertEqual(draft['photos'][0]['frame'],{'mode':'crop','x':50,'y':20})
  self.assertEqual(draft['travel']['area'],[22.1,113.5])
  self.assertIsInstance(draft['travel']['day'],int)

 def test_split_calls_have_unique_draft_ids_and_preserve_final_crop_cover(self):
  data=io.BytesIO();Image.new('RGB',(800,600),'blue').save(data,'JPEG')
  photos=[{'id':pid,'captured':'2026-08-18T10:00:00+08:00','taken':1000,'area':None} for pid in ('wide','detail','night','port')]
  safe={p['id']:{**p,'decision':'allow','flags':[],'landscape':True,'aesthetic':9 if p['id']=='wide' else 8,
        'description':'Public landmark','peopleRole':'none','compositionClear':True,'contentKind':'permanent_scenery',
        'light':'night' if p['id']=='night' else 'day','scene':'architecture',
        'place':{'city':'Hong Kong','landmark':'Port' if p['id']=='port' else 'Central','evidence':'public sign','confidence':'high'}} for p in photos}
  inv=MagicMock();inv.scan.return_value=True;inv.next_batch.return_value=photos
  inv.stage_batch.return_value='batch';inv.known_digest.return_value=False
  inv.progress.return_value={'total':4,'processed':0,'analyzed':0}
  inv.proposed_progress.return_value={'phase':'processing','total':4,'processed':4,'analyzed':4,'batches':1}
  completed=[];calls=[]
  def request(url,**kwargs):
   if url.endswith('/internal/claim'):result={'id':'job','lease':'test-lease'}
   elif url.endswith('/internal/source'):result={'pipeline':2,'progress':{'phase':'processing'},'maxPhotos':20,'draftLimit':6,'accessToken':'test-token'}
   elif url.endswith('/internal/complete'):completed.append(kwargs['body']);result={'count':len(kwargs['body']['drafts'])}
   else:result={}
   return json.dumps(result).encode()
  def gateway(prompt,records,paths,schema,cwd):
   if schema==b.SCREEN_SCHEMA:return {'photos':[safe[p['id']] for p in records]}
   if schema==CROSS_SCHEMA:return cross_checks(prompt)
   ids=[p['id'] for p in records];calls.append(ids)
   # The detail has a lower raw-image score but the better final crop.
   return {'drafts':[{'title':'Landmark','caption':'Public landmark.','hashtags':'#Architecture','reason':'Same site and light',
          'photos':[{'id':pid,'alt':'Landmark','frame':{'mode':'crop','x':50,'y':20}} for pid in reversed(ids)]}]}
  with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'PHOTOSTORY_URL':'https://example.invalid','PHOTOSTORY_BATCH_TOKEN':'test-token','CODEX_GATEWAY_COMMAND':'test-gateway','PHOTOSTORY_STATE_DIR':tmp}),patch('inventory.Inventory',return_value=inv),patch.object(b,'request',side_effect=request),patch.object(b,'thumbnail',return_value=data.getvalue()),patch.object(b,'gateway',side_effect=gateway),patch('preselect.representatives',side_effect=lambda previews,*args:[(p,image,{}) for p,image in previews]),patch('translate_labels.translate_labels',side_effect=lambda drafts,*args:drafts):
   b.run()
  self.assertEqual(calls,[['wide','detail'],['night'],['port']])
  drafts=completed[0]['drafts']
  self.assertEqual(len({d['id'] for d in drafts}),3)
  self.assertEqual([p['id'] for p in drafts[0]['photos']],['detail','wide'])
