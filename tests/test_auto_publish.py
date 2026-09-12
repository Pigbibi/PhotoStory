import io,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from PIL import Image
from auto_publish import render,tick
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
 def test_exact_render_is_reviewed_uploaded_and_temporary_files_removed(self):
  calls=[];seen=[]
  d={'id':'d','version':1,'aspect':'3:2','caption':'A coast.','photos':[{'id':'p','frame':{'mode':'crop','x':50,'y':50}}]}
  def call(path,b):
   calls.append(b)
   if b['action']=='candidate':return {'draft':d,'publication':{'id':'publication','status':'prepared'}}
   return {'ok':True}
  def gateway(prompt,records,paths,schema,cwd):
   seen.extend(paths)
   with Image.open(paths[0]) as image:self.assertEqual(image.size,(1080,720))
   return {k:k!='needsHumanReview' for k in FIELDS}
  self.assertTrue(tick(call,lambda *a:self.raw(),gateway))
  self.assertEqual([c['action'] for c in calls],['candidate','upload','begin'])
  self.assertEqual(len(calls[-1]['images'][0]['digest']),64)
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
  tick(call,lambda *a:self.raw(),lambda *a:{k:k!='needsHumanReview' for k in FIELDS})
  self.assertEqual(calls,['candidate','upload','begin'])
