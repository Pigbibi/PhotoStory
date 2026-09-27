import sys,tempfile,unittest
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from cross_review import cross_review

class CrossReviewTests(unittest.TestCase):
 def setUp(self):
  self.drafts=[{'id':'horizontal','title':'North Gate Street Scene','caption':'Colorful facades by North Gate.',
                'hashtags':'#NorthGate','photos':[{'id':'wide','alt':'Colorful building and hills'}]},
               {'id':'vertical','title':'South Gate Street Scene','caption':'A facade beside South Gate.',
                'hashtags':'#SouthGate','photos':[{'id':'tall','alt':'Colorful building and hills'}]}]
  self.screens=[{'id':pid,'description':'Colorful building and hills','place':{'city':'Example City','landmark':'South Gate','evidence':'South Gate sign','confidence':'high'}} for pid in ('wide','tall')]
 def test_cross_orientation_duplicate_and_uncertain_place_get_neutral_copy(self):
  with tempfile.TemporaryDirectory() as tmp:
   cwd=Path(tmp)
   for p in ('wide','tall'):Image.new('RGB',(100,80),'blue').save(cwd/(p+'.jpg'))
   def gateway(prompt,records,paths,schema,workdir):
    self.assertEqual([r['id'] for r in records],['wide','tall'])
    self.assertIn('first screening facts are AI-generated and may be wrong',prompt)
    self.assertIn('North Gate',prompt)
    self.assertIn('South Gate',prompt)
    def check(did,other):
     return {'draftId':did,'duplicateIds':other,'captionGrounded':True,'locationGrounded':True,
             'copy':{'title':'Colorful street facade','caption':'Colorful facades with hills beyond the street.',
                     'hashtags':'#Architecture #ColorfulFacade','reason':'Clear facade',
                     'photos':[{'id':'wide' if did=='horizontal' else 'tall','alt':'Colorful building and hills'}]}}
    return {'checks':[check('horizontal',['vertical']),check('vertical',[])]}
   clean,checks=cross_review(self.drafts,self.screens,[],cwd,gateway)
   self.assertEqual(checks[0]['duplicateIds'],['vertical'])
   self.assertEqual(checks[1]['duplicateIds'],['horizontal'])
   self.assertEqual(clean[0]['caption'],'Colorful facades with hills beyond the street.')
   self.assertEqual(clean[1]['title'],'Colorful street facade')
   self.assertNotIn('Gate',str(clean))
 def test_existing_approved_reference_and_invalid_result(self):
  with tempfile.TemporaryDirectory() as tmp:
   cwd=Path(tmp)
   Image.new('RGB',(100,80),'blue').save(cwd/'wide.jpg')
   draft=self.drafts[:1]
   reference=[{'id':'approved','status':'approved','title':'Colorful street','caption':'A colorful building and hills.', 'photos':[{'alt':'Colorful facade'}]}]
   def gateway(prompt,*args):
    self.assertIn('approved',prompt)
    return {'checks':[{'draftId':'horizontal','duplicateIds':['approved'],'captionGrounded':True,'locationGrounded':True,
                       'copy':{k:draft[0][k] for k in ('title','caption','hashtags','reason') if k in draft[0]}|{'reason':'Colorful scene','photos':[{'id':'wide','alt':'Colorful building and hills'}]}}]}
   self.assertEqual(cross_review(draft,self.screens,reference,cwd,gateway)[1][0]['duplicateIds'],['approved'])
   self.assertEqual(cross_review(draft,self.screens,reference,cwd,lambda *args:{'checks':[{'draftId':'horizontal','duplicateIds':['unknown'],'captionGrounded':True,'locationGrounded':True}]}),([],[]))

 def test_unsupported_copy_is_deferred(self):
  with tempfile.TemporaryDirectory() as tmp:
   cwd=Path(tmp);Image.new('RGB',(100,80),'blue').save(cwd/'wide.jpg')
   def gateway(*args):
    return {'checks':[{'draftId':'horizontal','duplicateIds':[],'captionGrounded':True,'locationGrounded':False,
                       'copy':{'title':'A facade','caption':'A colorful facade.','hashtags':'#Architecture','reason':'Colorful scene',
                               'photos':[{'id':'wide','alt':'Colorful building'}]}}]}
   self.assertEqual(cross_review(self.drafts[:1],self.screens,[],cwd,gateway),([],[]))
   self.assertEqual(cross_review(self.drafts[:1],self.screens,[],cwd,lambda *args: (_ for _ in ()).throw(RuntimeError())),([],[]))
