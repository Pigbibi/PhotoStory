import sys,unittest,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from auto_review import review_drafts,FIELDS
from PIL import Image
class AutoReviewTests(unittest.TestCase):
 def setUp(self):
  self.draft={'id':'d','title':'Coast','caption':'A coast.','hashtags':'#Coast','photos':[{'id':'p','alt':'Coast'}]}
  self.screen={'id':'p','decision':'allow','flags':[],'landscape':True,'aesthetic':9}
  self.source={'reviewMode':'strict_auto','strictAutoEnabled':True}
 def test_manual_and_low_score_use_no_extra_inference(self):
  def forbidden(*args):self.fail('extra AI must not run')
  self.assertEqual(review_drafts([self.draft],[self.screen],{},Path('/tmp'),forbidden),[])
  self.assertEqual(review_drafts([self.draft],[{**self.screen,'aesthetic':8}],self.source,Path('/tmp'),forbidden),[])
 def test_final_canvas_and_content_are_reviewed_and_temp_is_removed(self):
  with tempfile.TemporaryDirectory() as tmp:
   cwd=Path(tmp);Image.new('RGB',(800,400),'blue').save(cwd/'p.jpg')
   def gateway(prompt,records,paths,schema,path):
    self.assertIn('A coast.',prompt);self.assertEqual(records,[{'id':'p'}])
    with Image.open(paths[0]) as image:
     self.assertEqual(image.size,(600,750));self.assertEqual(image.getpixel((0,0)),(255,255,255))
    return {k:k!='needsHumanReview' for k in FIELDS}
   result=review_drafts([self.draft],[self.screen],self.source,cwd,gateway)
   self.assertEqual(result[0]['reviewedPost']['caption'],'A coast.')
   self.assertEqual(result[0]['photoIds'],['p']);self.assertEqual(list(cwd.glob('review-*')),[])
 def test_error_or_partial_result_leaves_manual_review(self):
  with tempfile.TemporaryDirectory() as tmp:
   cwd=Path(tmp);Image.new('RGB',(30,20)).save(cwd/'p.jpg')
   for result in [{}, {'needsHumanReview':False},None]:
    self.assertEqual(review_drafts([self.draft],[self.screen],self.source,cwd,lambda *args:result),[])
   def failure(*args):raise RuntimeError('private message must not be logged')
   self.assertEqual(review_drafts([self.draft],[self.screen],self.source,cwd,failure),[])
   self.assertEqual(list(cwd.glob('review-*')),[])

class CroppedReviewTests(unittest.TestCase):
 def test_crop_preview_and_evidence_match_final_post(self):
  with tempfile.TemporaryDirectory() as tmp:
   cwd=Path(tmp);Image.new('RGB',(800,600),'blue').save(cwd/'p.jpg')
   draft={'id':'d','title':'Coast','caption':'Coast.','hashtags':'#Coast','aspect':'3:2','photos':[{'id':'p','alt':'Coast','frame':{'mode':'crop','x':50,'y':20}}]}
   screen={'id':'p','decision':'allow','flags':[],'landscape':True,'aesthetic':9}
   def gateway(prompt,records,paths,schema,path):
    with Image.open(paths[0]) as image:
     self.assertEqual(image.size,(600,400))
     self.assertLess(image.getpixel((0,0))[0],10)
    return {k:k!='needsHumanReview' for k in FIELDS}
   result=review_drafts([draft],[screen],{'reviewMode':'strict_auto','strictAutoEnabled':True},cwd,gateway)
   self.assertEqual(len(result),1)
   self.assertEqual(result[0]['policy'],'strict-v2')
   self.assertEqual(result[0]['reviewedPost']['aspect'],'3:2')
   self.assertEqual(result[0]['reviewedPost']['photos'],draft['photos'])
