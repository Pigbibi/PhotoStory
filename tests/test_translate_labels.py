import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from translate_labels import translate_labels, LANGUAGE_NAMES, Stop

class TranslationTests(unittest.TestCase):
    def test_labels_only_and_original_content_unchanged(self):
        draft={'id':'d','title':'海岸','reason':'海景','caption':'Approved caption','status':'approved','photos':[{'id':'private-photo'}]}
        original=copy.deepcopy(draft)
        def gateway(prompt,records,paths,schema,cwd):
            self.assertEqual(records,[{'id':'d','title':'海岸','reason':'海景'}])
            self.assertEqual(paths,[])
            return {'labels':[{'id':'d','translations':{c:{'title':'Coast','reason':'Sea views'} for c in LANGUAGE_NAMES}}]}
        result=translate_labels([draft],gateway,None)[0]
        self.assertEqual(draft,original)
        self.assertEqual({k:v for k,v in result.items() if k!='translations'},original)
        self.assertEqual(len(result['translations']),13)
    def test_wrong_id_missing_language_and_oversize_rejected(self):
        draft={'id':'d','title':'Coast','reason':'Sea'}
        valid={'labels':[{'id':'d','translations':{c:{'title':'Coast','reason':'Sea'} for c in LANGUAGE_NAMES}}]}
        for mutation in ['id','missing','length']:
            result=copy.deepcopy(valid)
            if mutation=='id':result['labels'][0]['id']='another'
            if mutation=='missing':del result['labels'][0]['translations']['en']
            if mutation=='length':result['labels'][0]['translations']['en']['title']='x'*161
            with self.assertRaises(Stop):translate_labels([draft],lambda *a:result,None)
