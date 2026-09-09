import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import worker from '../worker/index.mjs';
import {hash} from '../worker/auth.mjs';

function database(path){
 const execute=(statements)=>{
   const p=spawnSync('python3',['-c',`import sqlite3,json,sys,base64
v=json.load(sys.stdin);db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
out=[]
with db:
 for s in v:
  args=[base64.b64decode(x['blob']) if isinstance(x,dict) and 'blob' in x else x for x in s['args']]
  cur=db.execute(s['sql'],args)
  rows=[dict(r) for r in cur.fetchall()] if cur.description else []
  out.append({'results':rows,'meta':{'changes':max(cur.rowcount,0)}})
print(json.dumps(out))`,path],{input:JSON.stringify(statements.map(s=>({sql:s.sql,args:s.args.map(x=>x instanceof ArrayBuffer?{blob:Buffer.from(x).toString('base64')}:x)}))),encoding:'utf8'});
   if(p.status) throw new Error(p.stderr);
   return JSON.parse(p.stdout);
 };
 return {prepare(sql){return {bind(...args){return {sql,args,first:async()=>execute([{sql,args}])[0].results[0]||null,all:async()=>execute([{sql,args}])[0],run:async()=>execute([{sql,args}])[0]};},first:async()=>execute([{sql,args:[]}])[0].results[0]||null,all:async()=>execute([{sql,args:[]}])[0]};},batch:async stmts=>execute(stmts)};
}
async function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'photostory-test-'));t.after(()=>rmSync(dir,{recursive:true}));
 const path=join(dir,'db');
 const p=spawnSync('python3',['-c','import sqlite3,sys;sqlite3.connect(sys.argv[1]).executescript(sys.stdin.read())',path],{input:readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8')});assert.equal(p.status,0);
 const DB=database(path);
 await DB.prepare('INSERT INTO state VALUES(?,?,?)').bind('session:'+await hash('session'),JSON.stringify({login:'Pigbibi'}),Date.now()+1000000).run();
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('microsoft','{}').run();
 const env={DB,ALLOWED_GITHUB_USERS:'Pigbibi',BATCH_TOKEN:'machine'};
 const api=async(path,body,machine=false)=>worker.fetch(new Request('https://example.test'+path,{method:'POST',headers:machine?{Authorization:'Bearer machine'}:{Cookie:'__Host-photostory=session',Origin:'https://example.test'},body:JSON.stringify(body)}),env);
 return {DB,api};
}
test('large jobs keep one active slot and acknowledge independent batches exactly once',async t=>{
 const {DB,api}=await setup(t);
 assert.equal((await api('/api/jobs',{folder:'Photos',range:'all',maxPhotos:100})).status,201);
 let claim=await(await api('/internal/claim',{},true)).json();
 const auth=()=>({jobId:claim.id,lease:claim.lease});
 const checkpoint={...auth(),progress:{phase:'scanning',total:250,processed:0,batches:0}};
 assert.equal((await api('/internal/checkpoint',checkpoint,true)).status,200);
 assert.equal((await api('/api/jobs',{folder:'Photos',range:'all'})).status,409);
 claim=await(await api('/internal/claim',{},true)).json();
 const first={...auth(),batchId:'batch1',more:true,progress:{phase:'processing',total:250,processed:100,batches:1},drafts:[{id:claim.id+'-batch1-1',title:'Coast',caption:'Quiet coast.',photos:[{id:'photo1',alt:'Coast'}]}],photos:[{id:'photo1',safety:'allow',flags:[],jpeg:'/9j/'}]};
 assert.equal((await api('/internal/complete',first,true)).status,200);
 assert.equal((await api('/internal/complete',first,true)).status,409);
 const row=await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(claim.id).first();
 assert.equal(row.status,'pending');assert.equal(JSON.parse(row.body).lastBatch,'batch1');
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM drafts').all()).results[0].n,1);
 claim=await(await api('/internal/claim',{},true)).json();
 const second={...auth(),batchId:'batch2',more:true,progress:{phase:'processing',total:250,processed:200,batches:2},drafts:[],photos:[]};
 assert.equal((await api('/internal/complete',second,true)).status,200);
 claim=await(await api('/internal/claim',{},true)).json();
 assert.equal((await api('/internal/complete',{...auth(),batchId:'batch3',more:false,progress:{phase:'complete',total:250,processed:250,batches:3},drafts:[],photos:[]},true)).status,200);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(claim.id).first()).status,'complete');
});
test('stop request survives a batch commit and no further batch can be claimed',async t=>{
 const {DB,api}=await setup(t);
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const claim=await(await api('/internal/claim',{},true)).json();
 assert.equal((await api('/api/jobs/'+claim.id+'/stop',{})).status,200);
 assert.equal((await api('/internal/checkpoint',{jobId:claim.id,lease:claim.lease,progress:{phase:'scanning',total:25,processed:0,batches:0}},true)).status,200);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(claim.id).first()).status,'cancelled');
 assert.equal(await(await api('/internal/claim',{},true)).json(),null);
});
test('stop arriving after the lease read is preserved by the atomic batch update',async t=>{
 const {DB,api}=await setup(t);
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const claim=await(await api('/internal/claim',{},true)).json();
 const commit=DB.batch;
 DB.batch=async statements=>{
   await api('/api/jobs/'+claim.id+'/stop',{});
   return commit(statements);
 };
 const result=await api('/internal/complete',{jobId:claim.id,lease:claim.lease,batchId:'race',more:true,progress:{phase:'processing',total:40,processed:20,batches:1},drafts:[],photos:[]},true);
 assert.equal(result.status,200);
 const job=await DB.prepare('SELECT body,status FROM jobs WHERE id=?').bind(claim.id).first();
 assert.equal(job.status,'cancelled');assert.equal(JSON.parse(job.body).stopRequested,true);
});
