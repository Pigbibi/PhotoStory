import io,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from PIL import Image
from auto_publish import render,tick,AutomaticPublishingStopped
from auto_review import FIELDS

class AutomaticPublishingTests(unittest.TestCase):
 def raw(self,size=(1800,1200)):
  out=io.BytesIO();image=Image.new('RGB',size,'blue');exif=Image.Exif();exif[270]='private';image.save(out,'JPEG',exif=exif);return out.getvalue()
 def test_crop_dimensions_and_metadata(self):
  for aspect,size in [('3:2',(1080,720)),('4:5',(1080,1350)),('1:1',(1080,1080))]:
   data=render(self.raw((2400,2400)),aspect,{'mode':'crop','x':20,'y':80})
   with Image.open(io.BytesIO(data)) as image:
    self.assertEqual(image.size,size);self.assertFalse(image.getexif());self.assertNotIn('exif',image.info)
  with self.assertRaises(ValueError):render(self.raw((100,100)),'3:2',{'mode':'crop','x':50,'y':50})
 def test_manual_has_no_download_or_ai(self):
  def forbidden(*a):self.fail('no work when manual')
  self.assertIsNone(tick(lambda *a:None,forbidden,forbidden))
 def test_one_run_finishes_a_carousel_without_waiting_for_another_schedule(self):
  calls=[]
  states=iter([{'status':'publishing','retryAfterMs':60000},
               {'status':'publishing','retryAfterMs':0},
               {'status':'published','retryAfterMs':0}])
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':
    return {'draft':{'id':'d','version':1},'publication':{'id':'publication','status':'publishing'}}
   return next(states)
  def forbidden(*args):self.fail('continuation must not download or review again')
  with patch('time.sleep') as sleep:
   self.assertTrue(tick(call,forbidden,forbidden))
  self.assertEqual(calls,['candidate','advance','advance','advance'])
  sleep.assert_called_once_with(60)
 def test_uncertain_result_stops_without_another_advance(self):
  calls=[]
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':return {'draft':{'id':'d','version':1},'publication':{'id':'publication','status':'publishing'}}
   return {'status':'uncertain'}
  with self.assertRaises(AutomaticPublishingStopped):tick(call,None,None)
  self.assertEqual(calls,['candidate','advance'])
 def test_advance_network_ambiguity_never_retries(self):
  calls=[]
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':return {'draft':{'id':'d','version':1},'publication':{'id':'publication','status':'publishing'}}
   raise OSError('SYNTHETIC_PRIVATE provider URL and token')
  with self.assertRaises(AutomaticPublishingStopped) as error:tick(call,None,None)
  self.assertNotIn('SYNTHETIC_PRIVATE',str(error.exception))
  self.assertEqual(calls,['candidate','advance'])
 def test_time_bound_stops_before_another_operation(self):
  calls=[]
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':return {'draft':{'id':'d','version':1},'publication':{'id':'publication','status':'publishing'}}
   return {'status':'publishing','retryAfterMs':60000}
  with patch('auto_publish.time.monotonic',side_effect=[0,0,0,1200]),patch('auto_publish.time.sleep') as sleep:
   with self.assertRaises(AutomaticPublishingStopped):tick(call,None,None)
  self.assertEqual(calls,['candidate','advance']);sleep.assert_not_called()
 def test_step_bound_stops_an_unfinished_post(self):
  calls=[]
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':return {'draft':{'id':'d','version':1},'publication':{'id':'publication','status':'publishing'}}
   return {'status':'publishing','retryAfterMs':0}
  with patch('auto_publish.MAX_PUBLICATION_STEPS',2):
   with self.assertRaises(AutomaticPublishingStopped):tick(call,None,None)
  self.assertEqual(calls,['candidate','advance','advance'])
 def test_existing_blocked_queue_is_reported_without_a_write(self):
  paths=[]
  def call(path,b):
   paths.append(path)
   if path.endswith('/health'):
    self.assertIsNone(b)
    return {'automation':{'publishMode':'automatic'},'publication':{'status':'uncertain'}}
  with self.assertRaises(AutomaticPublishingStopped):tick(call,None,None)
  self.assertEqual(paths,['/internal/autopublish','/internal/health'])
 def test_exact_render_is_reviewed_uploaded_and_temporary_files_removed(self):
  calls=[];seen=[]
  d={'id':'d','version':1,'aspect':'3:2','caption':'A coast.','photos':[{'id':'p','frame':{'mode':'crop','x':50,'y':50}}]}
  def call(path,b):
   calls.append(b)
   if b['action']=='candidate':return {'draft':d,'publication':{'id':'publication','status':'prepared'}}
   if b['action']=='begin':return {'status':'publishing'}
   if b['action']=='advance':return {'status':'published'}
   return {'ok':True}
  def gateway(prompt,records,paths,schema,cwd):
   seen.extend(paths)
   with Image.open(paths[0]) as image:self.assertEqual(image.size,(1080,720))
   return {k:k!='needsHumanReview' for k in FIELDS}
  self.assertTrue(tick(call,lambda *a:self.raw(),gateway))
  self.assertEqual([c['action'] for c in calls],['candidate','upload','begin','advance'])
  self.assertEqual(len(calls[-2]['images'][0]['digest']),64)
  self.assertFalse(any(p.exists() for p in seen))
 def test_review_rejection_never_begins(self):
  calls=[]
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':return {'draft':{'id':'d','version':1,'aspect':'3:2','photos':[{'id':'p','frame':{'mode':'crop','x':50,'y':50}}]},'publication':{'id':'p','status':'prepared'}}
  tick(call,lambda *a:self.raw(),lambda *a:{k:True for k in FIELDS})
  self.assertEqual(calls,['candidate','upload','reject'])
 def test_network_ambiguity_at_begin_never_retries_or_rejects(self):
  calls=[]
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':return {'draft':{'id':'d','version':1,'aspect':'3:2','photos':[{'id':'p','frame':{'mode':'crop','x':50,'y':50}}]},'publication':{'id':'p','status':'prepared'}}
   if b['action']=='begin':raise OSError('network')
  with self.assertRaises(AutomaticPublishingStopped):tick(call,lambda *a:self.raw(),lambda *a:{k:k!='needsHumanReview' for k in FIELDS})
  self.assertEqual(calls,['candidate','upload','begin'])
 def test_owner_scheduled_candidate_skips_second_subjective_review(self):
  calls=[]
  def call(path,b):
   calls.append(b['action'])
   if b['action']=='candidate':return {'draft':{'id':'d','version':1,'approvalSource':'owner_scheduled_v1','aspect':'3:2','photos':[{'id':'p','frame':{'mode':'crop','x':50,'y':50}}]},'publication':{'id':'p','status':'prepared'}}
   if b['action']=='begin':return {'status':'publishing'}
   if b['action']=='advance':return {'status':'published'}
   return {'ok':True}
  def forbidden(*args):self.fail('owner scheduled must not invoke subjective AI review')
  self.assertTrue(tick(call,lambda *a:self.raw(),forbidden))
  self.assertEqual(calls,['candidate','upload','begin','advance'])
