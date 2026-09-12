import io,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
from PIL import Image,ImageDraw,ImageFilter
from preselect import profile,representatives,cover_first

def photo(name,taken=1000,blur=0,variant=False):
 image=Image.new('RGB',(240,160),'skyblue');d=ImageDraw.Draw(image)
 d.rectangle((15,70,210,150),fill='darkgreen');d.rectangle((80 if not variant else 10,30,150 if not variant else 65,100),fill='brown')
 for x in range(25,210,12):d.line((x,85,x+4,145),fill='white',width=2)
 if blur:image=image.filter(ImageFilter.GaussianBlur(blur))
 out=io.BytesIO();image.save(out,'JPEG',quality=85)
 return ({'id':name,'taken':taken},out.getvalue())

class PreselectTests(unittest.TestCase):
 def test_exact_duplicate_and_blurred_burst_keep_sharp_representative(self):
  a,b=photo('sharp'),photo('blur',1001,2)
  chosen=representatives([b,a,({'id':'copy','taken':1002},a[1])])
  self.assertEqual([p['id'] for p,data,features in chosen],['sharp'])
 def test_different_angle_or_distant_capture_is_retained(self):
  values=[photo('a'),photo('angle',1001,variant=True),photo('later',2000,blur=1)]
  self.assertEqual(len(representatives(values)),3)
 def test_low_detail_images_are_not_merged_by_hash_alone(self):
  values=[]
  for i,color in enumerate(['#606060','#626262']):
   out=io.BytesIO();Image.new('RGB',(240,160),color).save(out,'JPEG');values.append(({'id':str(i),'taken':1000+i},out.getvalue()))
  self.assertEqual(len(representatives(values)),2)
 def test_cached_near_match_is_skipped_but_better_image_retained(self):
  p,data=photo('old');previous=profile(p,data)
  self.assertEqual(representatives([photo('blur',1001,2)],lambda p:[previous]),[])
  blur_p,blur_data=photo('oldblur',1000,2)
  self.assertEqual(len(representatives([photo('sharp',1001)],lambda p:[profile(blur_p,blur_data)])),1)

class CoverTests(unittest.TestCase):
 def test_best_score_leads_and_equal_scores_keep_editor_choice(self):
  photos=[{'id':'a'},{'id':'b'},{'id':'c'}]
  self.assertEqual([p['id'] for p in cover_first(photos,{'a':8,'b':9,'c':9})],['b','a','c'])
  self.assertEqual([p['id'] for p in photos],['a','b','c'])
