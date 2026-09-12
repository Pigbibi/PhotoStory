import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
import tempfile, unittest
from inventory import Inventory, event_batches

class InventoryTests(unittest.TestCase):
    def source(self): return {'folder':'Photos','start':None,'end':None,'knownPhotoIds':[]}
    def record(self,i):
        return {'id':str(i),'item':str(i),'captured':'2026-08-20T00:00:00+00:00','taken':1000+i,'area':None,'fingerprint':'version-'+str(i)}
    def test_paged_scan_and_multiple_batches_resume_without_repeating(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls=[]
            def graph(url):
                calls.append(url)
                if '/root:/' in url: return {'id':'root','folder':{}}
                if url=='https://graph.microsoft.com/next': return {'value':[self.record(i) for i in range(200,250)]}
                return {'value':[self.record(i) for i in range(200)],'@odata.nextLink':'https://graph.microsoft.com/next'}
            inv=Inventory(tmp,'job',self.source(),'policy')
            self.assertFalse(inv.scan(graph,lambda x:x,page_budget=1)); inv.close()
            inv=Inventory(tmp,'job',self.source(),'policy')
            self.assertTrue(inv.scan(graph,lambda x:x,page_budget=1))
            self.assertEqual(len(calls),3)
            seen=[]
            for expected in (100,100,50):
                batch=inv.next_batch(100); self.assertEqual(len(batch),expected)
                seen += [x['id'] for x in batch]
                bid=inv.stage_batch(batch)
                inv.save_digests({})
                inv.reconcile(bid) # Simulate commit succeeded but response/client was lost.
            self.assertEqual(len(set(seen)),250)
            self.assertEqual(inv.progress()['processed'],250)
            self.assertEqual(inv.next_batch(100),[])
            inv.close()
            # A new overlapping job reuses completed analysis (including rejected photos).
            inv=Inventory(tmp,'second',self.source(),'policy')
            self.assertTrue(inv.scan(graph,lambda x:x,page_budget=10))
            self.assertEqual(inv.next_batch(100),[]); inv.close()
    def test_unknown_batch_outcome_never_replays_ai(self):
        with tempfile.TemporaryDirectory() as tmp:
            inv=Inventory(tmp,'job',self.source(),'policy')
            inv.stage_batch([])
            with self.assertRaisesRegex(ValueError,'batch_outcome_unknown'): inv.reconcile(None)
            inv.close()
    def test_missing_local_progress_does_not_restart_acknowledged_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'local_state_missing'):
                Inventory(tmp,'missing',{**self.source(),'progress':{'total':10,'batches':1}},'policy')

    def test_cursor_cycle_is_rejected_not_silently_completed(self):
        with tempfile.TemporaryDirectory() as tmp:
            inv=Inventory(tmp,'job',self.source(),'policy')
            def graph(url):
                if '/root:/' in url: return {'id':'root','folder':{}}
                return {'value':[],'@odata.nextLink':url}
            with self.assertRaisesRegex(ValueError,'pagination_cycle'): inv.scan(graph,lambda x:x)
            inv.close()
    def test_event_boundaries_use_time_and_coarse_place_without_inventing_location(self):
        a=self.record(0); b={**self.record(1),'taken':1001,'area':[0,0]}
        c={**self.record(2),'taken':1002,'area':[20,20]}
        d={**self.record(3),'taken':1002+24*3600}
        self.assertEqual([len(x) for x in event_batches([a,b,c,d])],[2,1,1])

    def test_theme_unmatched_is_deferred_and_not_cached_for_future_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            inv=Inventory(tmp,'job',self.source(),'policy')
            photo=self.record(1)
            inv.db.execute('INSERT INTO photos(id,body,taken,fingerprint,status) VALUES(?,?,?,?,?)',(photo['id'],__import__('json').dumps(photo),photo['taken'],photo['fingerprint'],'pending'))
            inv.db.commit(); bid=inv.stage_batch([photo])
            inv.save_screening({'1':'digest'},{'1':{'taken':1001,'digest':'digest'}},{'1':'theme_unmatched'})
            inv.reconcile(bid)
            row=inv.db.execute('SELECT status,outcome FROM photos WHERE id=?',('1',)).fetchone()
            self.assertEqual(tuple(row),('deferred','theme_unmatched'))
            self.assertFalse(inv.db.execute('SELECT 1 FROM cache.analyzed').fetchone())
            inv.close()
            # A later job has a separate per-job photo table; because the
            # deferred decision was intentionally omitted from shared cache,
            # the same source item is discovered as a fresh pending candidate.
            later=Inventory(tmp,'later',self.source(),'policy')
            def graph(url):
                if '/root:/' in url: return {'id':'root','folder':{}}
                return {'value':[photo]}
            self.assertTrue(later.scan(graph,lambda x:x))
            self.assertEqual([p['id'] for p in later.next_batch(10)],['1'])
            later.close()

    def test_history_batches_never_enter_shared_ai_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            inv=Inventory(tmp,'history',self.source(),'policy')
            photo=self.record(1)
            inv.db.execute('INSERT INTO photos(id,body,taken,fingerprint,status) VALUES(?,?,?,?,?)',(photo['id'],__import__('json').dumps(photo),photo['taken'],photo['fingerprint'],'pending'))
            inv.db.commit()
            batch=inv.history_batch(10); self.assertEqual([p['id'] for p in batch],['1'])
            bid=inv.stage_batch(batch); inv.save_history_batch({'1':'abcd'})
            inv.reconcile_history(bid)
            self.assertEqual(inv.history_progress()['processed'],1)
            self.assertEqual(inv.next_batch(10),[])
            self.assertIsNone(inv.db.execute('SELECT 1 FROM cache.analyzed').fetchone())
            self.assertEqual(inv.db.execute("SELECT value FROM cache.history_meta WHERE key='photo:version-1'").fetchone()[0],'abcd')
            inv.close()

    def test_history_scan_revisits_photos_already_known_to_ai(self):
        with tempfile.TemporaryDirectory() as tmp:
            source={**self.source(),'mode':'history_match','knownPhotoIds':['1']}
            photo=self.record(1)
            inv=Inventory(tmp,'history-all',source,'policy')
            def graph(url):
                if '/root:/' in url: return {'id':'root','folder':{}}
                return {'value':[photo]}
            self.assertTrue(inv.scan(graph,lambda x:x))
            self.assertEqual([p['id'] for p in inv.history_batch(10)],['1'])
            self.assertEqual(inv.history_progress()['processed'],0)
            inv.close()

if __name__=='__main__': unittest.main()

class ScreeningBudgetTests(unittest.TestCase):
    source=InventoryTests.source
    record=InventoryTests.record
    def test_duplicates_do_not_spend_budget_and_profiles_survive_acknowledgement(self):
        with tempfile.TemporaryDirectory() as tmp:
            inv=Inventory(tmp,'budget',self.source(),'policy')
            photos=[self.record(1),self.record(2)]
            for p in photos:inv.db.execute('INSERT INTO photos(id,body,taken,fingerprint,status) VALUES(?,?,?,?,?)',(p['id'],__import__('json').dumps(p),p['taken'],p['fingerprint'],'pending'))
            inv.db.commit();bid=inv.stage_batch(photos)
            features={'taken':1001,'digest':'example'}
            inv.save_screening({'1':'a','2':'b'},{'1':features})
            self.assertEqual(inv.proposed_progress()['analyzed'],1)
            self.assertEqual(inv.proposed_progress()['processed'],2)
            self.assertEqual(inv.nearby_profiles(photos[0]),[])
            inv.reconcile(bid);inv.reconcile(bid)
            self.assertEqual(inv.progress()['analyzed'],1)
            self.assertEqual(inv.nearby_profiles(photos[0]),[features])
            inv.close()
