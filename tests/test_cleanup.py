import os,sys,tempfile,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
from cleanup_temp import clean_targets

class CleanupTests(unittest.TestCase):
    def test_only_old_owned_temporary_targets_are_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);inbox=root/'input';outbox=root/'output';ai=root/'ai'
            for p in (inbox,outbox,ai):p.mkdir()
            now=time.time();old=now-2*86400
            for p in (inbox/'image-0.jpg',inbox/'client.lock',outbox/'response.json',ai/'auth.json'):
                p.write_text('test');os.utime(p,(old,old))
            (inbox/'image-1.jpg').write_text('fresh')
            expired=ai/'call-expired';expired.mkdir();(expired/'image-0.jpg').write_text('test');os.utime(expired,(old,old))
            fresh=ai/'call-current';fresh.mkdir()
            outside=root/'outside';outside.mkdir();(outside/'keep').write_text('keep')
            (ai/'call-linked').symlink_to(outside,target_is_directory=True)
            counts=clean_targets(inbox,outbox,ai,now)
            self.assertEqual(counts,{'files':2,'directories':1})
            for p in (inbox/'client.lock',inbox/'image-1.jpg',ai/'auth.json',fresh,outside/'keep',ai/'call-linked'):
                self.assertTrue(p.exists())

if __name__=='__main__':unittest.main()
