import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import {defaults,settingsInput,nextRun,maintenance,settingsView} from '../worker/lifecycle.mjs';
import {reviewDraft} from '../worker/review.mjs';
import worker from '../worker/index.mjs';
const now=Date.parse('2026-09-10T00:00:00Z');
const config=()=>({...defaults,enabled:true,folder:'Photos',range:'1m',nextRun:now-1,version:1});
const draft=(id,photos,status='draft',trashedAt)=>({id,title:'Coast',caption:'Quiet coast.',hashtags:'',photos:photos.map(id=>({id,alt:'Coast'})),status,version:1,...(trashedAt?{trashedAt}:{})});
async function addDraft(DB,d){await DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind(d.id,JSON.stringify(d)).run();}
test('weekly/monthly schedules use Shanghai calendar and skip missed slots',()=>{
 assert.equal(new Date(nextRun({...defaults,weekday:4,hour:9},now)).toISOString(),'2026-09-10T01:00:00.000Z');
 assert.equal(new Date(nextRun({...defaults,weekday:4,hour:9},now+3600000)).toISOString(),'2026-09-17T01:00:00.000Z');
 assert.equal(new Date(nextRun({...defaults,frequency:'monthly',monthDay:31,hour:9},Date.parse('2026-02-01T00:00Z'))).toISOString(),'2026-02-28T01:00:00.000Z');
 assert.throws(()=>settingsInput({...defaults,enabled:true,folder:'Photos',range:'custom'},now),/invalid/);
 assert.throws(()=>settingsInput({...defaults,pendingLimit:0},now),/invalid/);
});
test('trash preserves preview references and restores to unapproved draft',()=>{
 const original=draft('one',['p'],'approved');
 const trash=reviewDraft(original,{version:1,action:'trash'},now);
 assert.equal(trash.status,'trash');assert.equal(trash.trashedAt,now);assert.deepEqual(trash.photos,original.photos);
 assert.throws(()=>reviewDraft(trash,{...trash,action:'approve'}),/invalid_action/);
 const restored=reviewDraft(trash,{version:2,action:'restore'},now+1);
 assert.equal(restored.status,'draft');assert.equal(restored.trashedAt,undefined);
 assert.throws(()=>reviewDraft(trash,{version:1,action:'restore'}),/version_conflict/);
});
test('maintenance queues a due job only once with a per-run limit',async t=>{
 const {DB,env}=await setup(t);
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('automation',JSON.stringify(config())).run();
 await maintenance(env,now);await maintenance(env,now);
 const rows=(await DB.prepare('SELECT body FROM jobs').all()).results;
 assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].body).analysisLimit,300);
 assert.ok((await settingsView(env,now)).settings.nextRun>now);
});
test('backlog blocks scheduled creation and resumes once reviewed',async t=>{
 const {DB,env}=await setup(t);
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('automation',JSON.stringify({...config(),pendingLimit:1})).run();
 await addDraft(DB,draft('waiting',['p']));await maintenance(env,now);
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM jobs').all()).results[0].n,0);
 await DB.prepare("UPDATE drafts SET body=json_set(body,'$.status','approved') WHERE id=?").bind('waiting').run();
 await maintenance(env,now+1);
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM jobs').all()).results[0].n,1);
});
test('daily cleanup retains pending, approved, fresh trash and shared previews',async t=>{
 const {DB,env}=await setup(t);const old=now-31*86400000;
 for(const id of ['keep','shared','expired','fresh','edited'])await DB.prepare('INSERT INTO photos VALUES(?,?,?)').bind(id,new Uint8Array([255,216,255]).buffer,'image/jpeg').run();
 await addDraft(DB,draft('pending',['keep']));await addDraft(DB,draft('approved',['shared'],'approved'));
 await addDraft(DB,draft('old',['expired','shared'],'trash',old));await addDraft(DB,draft('new',['fresh'],'trash',now-1));
 await DB.prepare('INSERT INTO photo_gc VALUES(?,?)').bind('edited',now-1).run();
 await maintenance(env,now);
 assert.deepEqual((await DB.prepare('SELECT id FROM photos ORDER BY id').all()).results.map(x=>x.id),['fresh','keep','shared']);
 assert.deepEqual((await DB.prepare('SELECT id FROM drafts ORDER BY id').all()).results.map(x=>x.id),['approved','new','pending']);
 await maintenance(env,now+1); // Safe repeated tick; not another cleanup or new job.
 assert.equal((await settingsView(env,now)).cleanup.lastAt,now);
});
test('settings updates are owner-only, same-origin and version checked',async t=>{
 const {env}=await setup(t);
 const request=(body,headers)=>worker.fetch(new Request('https://example.test/api/settings',{method:'PUT',headers,body:JSON.stringify(body)}),env);
 assert.equal((await request(defaults,{})).status,401);
 assert.equal((await request(defaults,{Cookie:'__Host-photostory=session',Origin:'https://other.test'})).status,403);
 const headers={Cookie:'__Host-photostory=session',Origin:'https://example.test'};
 assert.equal((await request(defaults,headers)).status,200);
 assert.equal((await request(defaults,headers)).status,409);
});
test('a scheduled analysis budget stops at its exact limit and rejects an overshoot',async t=>{
 const {DB,api}=await setup(t);
 await api('/api/jobs',{folder:'Photos',range:'all',maxPhotos:20});
 await DB.prepare("UPDATE jobs SET body=json_set(body,'$.analysisLimit',25)").bind().run();
 let claim=await(await api('/internal/claim',{},true)).json();
 const commit=(processed,analyzed,batches)=>api('/internal/complete',{jobId:claim.id,lease:claim.lease,batchId:'budget'+batches,more:true,progress:{phase:'processing',total:100,processed,analyzed,batches},drafts:[],photos:[]},true);
 assert.equal((await commit(20,20,1)).status,200);
 claim=await(await api('/internal/claim',{},true)).json();
 assert.equal((await commit(40,40,2)).status,400);
 assert.equal((await commit(25,25,2)).status,200);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(claim.id).first()).status,'limited');
 assert.equal(await(await api('/internal/claim',{},true)).json(),null);
});
test('backlog pauses claims without cancelling the owner job',async t=>{
 const {DB,api}=await setup(t);
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('automation',JSON.stringify({...config(),pendingLimit:1})).run();
 await api('/api/jobs',{folder:'Photos',range:'all'});await addDraft(DB,draft('waiting',['p']));
 assert.equal(await(await api('/internal/claim',{},true)).json(),null);
 await DB.prepare("UPDATE drafts SET body=json_set(body,'$.status','approved') WHERE id=?").bind('waiting').run();
 assert.ok((await(await api('/internal/claim',{},true)).json()).lease);
});
test('removing a photo queues delayed collection; stale edits cannot replace the draft',async t=>{
 const {DB,env}=await setup(t);const original=draft('edit',['p1','p2']);await addDraft(DB,original);
 const send=b=>worker.fetch(new Request('https://example.test/api/drafts/edit',{method:'PATCH',headers:{Cookie:'__Host-photostory=session',Origin:'https://example.test'},body:JSON.stringify(b)}),env);
 const before=Date.now();
 assert.equal((await send({...original,action:'save',photos:[original.photos[0]]})).status,200);
 assert.equal((await send({...original,action:'trash'})).status,409);
 const gc=await DB.prepare('SELECT * FROM photo_gc WHERE photo_id=?').bind('p2').first();
 assert.ok(gc.expires>=before+30*86400000);
});
test('disabling the schedule during a tick cannot create a job from stale settings',async t=>{
 const {DB,env}=await setup(t);
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('automation',JSON.stringify({...config(),cleanupEnabled:false})).run();
 const batch=DB.batch;DB.batch=async statements=>{
   await DB.prepare("UPDATE state SET value=json_set(value,'$.enabled',json('false'),'$.version',2,'$.nextRun',NULL) WHERE key='automation'").bind().run();
   return batch(statements);
 };
 await maintenance(env,now);
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM jobs').all()).results[0].n,0);
 assert.equal((await settingsView(env,now)).settings.enabled,false);
});
test('a failed scheduled job disables further scheduled scans until owner re-enables',async t=>{
 const {DB,api,env}=await setup(t);
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('automation',JSON.stringify(config())).run();
 await maintenance(env,now);
 const job=await(await api('/internal/claim',{},true)).json();
 assert.equal((await api('/internal/fail',{jobId:job.id,lease:job.lease},true)).status,200);
 assert.equal((await settingsView(env,now)).settings.enabled,false);
 await maintenance(env,now+40*86400000);
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM jobs').all()).results[0].n,1);
});

test('fixed start date is saved while the schedule end moves with today',async t=>{
 const {jobInput}=await import('../worker/jobs.mjs');
 const s=settingsInput({...config(),range:'since',start:'2025-05-01'},now);
 assert.equal(s.start,'2025-05-01');assert.equal(defaults.analysisLimit,300);
 assert.equal(jobInput(s,new Date(now)).end,'2026-09-11');
 assert.equal(jobInput(s,new Date(now+86400000)).end,'2026-09-12');
 for(const start of ['',null,'2025-02-30','2027-01-01'])assert.throws(()=>settingsInput({...config(),range:'since',start},now),/invalid_dates/);
});
test('prefiltered photos advance progress without consuming the AI budget',async t=>{
 const {DB,api}=await setup(t);await api('/api/jobs',{folder:'Photos',range:'all',maxPhotos:20});
 await DB.prepare("UPDATE jobs SET body=json_set(body,'$.analysisLimit',300)").bind().run();
 const c=await(await api('/internal/claim',{},true)).json();
 const send=analyzed=>api('/internal/complete',{jobId:c.id,lease:c.lease,batchId:'filtered',more:true,progress:{phase:'processing',total:100,processed:20,analyzed,batches:1},drafts:[],photos:[]},true);
 assert.equal((await send(21)).status,400);assert.equal((await send(0)).status,200);
 assert.equal((await DB.prepare('SELECT status FROM jobs').first()).status,'pending');
});

test('custom fixed dates round-trip without widening the end date',()=>{
 const s=settingsInput({...config(),range:'custom',start:'2025-06-01',end:'2025-08-31'},now);
 assert.equal(s.start,'2025-06-01');assert.equal(s.end,'2025-08-31');
 assert.deepEqual(settingsInput(s,now),s);
 assert.throws(()=>settingsInput({...config(),range:'custom',start:'2025-06-01',end:'2025-05-01'},now),/invalid_dates/);
});
