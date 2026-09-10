"""Exercise the real batch wiring with local JPEGs and no external calls."""
import io,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,MagicMock
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import process_batch as b

class ProcessorRunTests(unittest.TestCase):
 def test_screened_pixels_reach_grouping_and_saved_crop(self):
  data=io.BytesIO();Image.new('RGB',(800,600),'blue').save(data,'JPEG')
  photo={'id':'p','captured':'2026-08-18','area':None}
  safe={'id':'p','decision':'allow','flags':[],'landscape':True,'aesthetic':8,'description':'Coast'}
  inv=MagicMock();inv.scan.return_value=True;inv.next_batch.return_value=[photo]
  inv.stage_batch.return_value='batch';inv.known_digest.return_value=False
  inv.progress.return_value={'total':1,'processed':0,'analyzed':0}
  inv.proposed_progress.return_value={'phase':'processing','total':1,'processed':1,'analyzed':1,'batches':1}
  completed=[]
  def request(url,**kwargs):
   if url.endswith('/internal/claim'): result={'id':'job','lease':'test-lease'}
   elif url.endswith('/internal/source'): result={'pipeline':2,'progress':{'phase':'processing'},'maxPhotos':20,'draftLimit':3,'accessToken':'test-token'}
   elif url.endswith('/internal/complete'):
    completed.append(kwargs['body']);result={'count':len(kwargs['body']['drafts'])}
   else:result={}
   return json.dumps(result).encode()
  def gateway(prompt,records,paths,schema,cwd):
   if schema==b.SCREEN_SCHEMA:return {'photos':[safe]}
   self.assertEqual([p['id'] for p in records],['p'])
   self.assertIn('Target aspect: 3:2',prompt)
   return {'drafts':[{'title':'Coast','caption':'A coast.','hashtags':'#Coast','reason':'Theme','photos':[{'id':'p','alt':'Coast','frame':{'mode':'crop','x':50,'y':20}}]}]}
  with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'PHOTOSTORY_URL':'https://example.invalid','PHOTOSTORY_BATCH_TOKEN':'test-token','CODEX_GATEWAY_COMMAND':'test-gateway','PHOTOSTORY_STATE_DIR':tmp}),patch('inventory.Inventory',return_value=inv),patch.object(b,'request',side_effect=request),patch.object(b,'thumbnail',return_value=data.getvalue()),patch.object(b,'gateway',side_effect=gateway),patch('translate_labels.translate_labels',side_effect=lambda drafts,*args:drafts):
   b.run()
  self.assertEqual(len(completed),1)
  draft=completed[0]['drafts'][0]
  self.assertEqual(draft['aspect'],'3:2')
  self.assertEqual(draft['photos'][0]['frame'],{'mode':'crop','x':50,'y':20})
