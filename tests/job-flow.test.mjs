import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';

test('large jobs keep one active slot and acknowledge independent batches exactly once',async t=>{
 const {DB,api}=await setup(t);
 assert.equal((await api('/api/jobs',{folder:'Photos',range:'all',maxPhotos:100})).status,201);
 let claim=await(await api('/internal/claim',{},true)).json();
 const auth=()=>({jobId:claim.id,lease:claim.lease});
 const checkpoint={...auth(),progress:{phase:'scanning',total:250,processed:0,analyzed:0,batches:0}};
 assert.equal((await api('/internal/checkpoint',checkpoint,true)).status,200);
 assert.equal((await api('/api/jobs',{folder:'Photos',range:'all'})).status,409);
 claim=await(await api('/internal/claim',{},true)).json();
 const first={...auth(),batchId:'batch1',more:true,progress:{phase:'processing',total:250,processed:100,analyzed:100,batches:1},drafts:[{id:claim.id+'-batch1-1',title:'Coast',caption:'Quiet coast.',photos:[{id:'photo1',alt:'Coast'}]}],photos:[{id:'photo1',safety:'allow',flags:[],jpeg:'/9j/'}]};
 assert.equal((await api('/internal/complete',first,true)).status,200);
 assert.equal((await api('/internal/complete',first,true)).status,409);
 const row=await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(claim.id).first();
 assert.equal(row.status,'pending');assert.equal(JSON.parse(row.body).lastBatch,'batch1');
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM drafts').all()).results[0].n,1);
 claim=await(await api('/internal/claim',{},true)).json();
 const second={...auth(),batchId:'batch2',more:true,progress:{phase:'processing',total:250,processed:200,analyzed:200,batches:2},drafts:[],photos:[]};
 assert.equal((await api('/internal/complete',second,true)).status,200);
 claim=await(await api('/internal/claim',{},true)).json();
 assert.equal((await api('/internal/complete',{...auth(),batchId:'batch3',more:false,progress:{phase:'complete',total:250,processed:250,analyzed:250,batches:3},drafts:[],photos:[]},true)).status,200);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(claim.id).first()).status,'complete');
});
test('stop request survives a batch commit and no further batch can be claimed',async t=>{
 const {DB,api}=await setup(t);
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const claim=await(await api('/internal/claim',{},true)).json();
 assert.equal((await api('/api/jobs/'+claim.id+'/stop',{})).status,200);
 assert.equal((await api('/internal/checkpoint',{jobId:claim.id,lease:claim.lease,progress:{phase:'scanning',total:25,processed:0,analyzed:0,batches:0}},true)).status,200);
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
 const result=await api('/internal/complete',{jobId:claim.id,lease:claim.lease,batchId:'race',more:true,progress:{phase:'processing',total:40,processed:20,analyzed:20,batches:1},drafts:[],photos:[]},true);
 assert.equal(result.status,200);
 const job=await DB.prepare('SELECT body,status FROM jobs WHERE id=?').bind(claim.id).first();
 assert.equal(job.status,'cancelled');assert.equal(JSON.parse(job.body).stopRequested,true);
});
test('manual scans inherit the saved total AI budget and cannot override it',async t=>{
 const {DB,api}=await setup(t);
 await DB.prepare("INSERT INTO state VALUES('automation',?,NULL)").bind(JSON.stringify({analysisLimit:3})).run();
 assert.equal((await api('/api/jobs',{folder:'Photos',range:'all',analysisLimit:999})).status,201);
 const c=await(await api('/internal/claim',{},true)).json();
 assert.equal(c.analysisLimit,3);
 const send=analyzed=>api('/internal/complete',{jobId:c.id,lease:c.lease,batchId:'budget',more:true,progress:{phase:'processing',total:100,processed:10,analyzed,batches:1},drafts:[],photos:[]},true);
 assert.equal((await send(4)).status,400);
 assert.equal((await send(3)).status,200);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(c.id).first()).status,'limited');
 assert.equal(await(await api('/internal/claim',{},true)).json(),null);
});
test('history-only verification clones the last source range without enabling AI drafts',async t=>{
 const {DB,api}=await setup(t);
 assert.equal((await api('/api/jobs',{folder:'Photos/Camera Roll',range:'3m',maxPhotos:50})).status,201);
 await DB.prepare("UPDATE jobs SET status='complete'").bind().run();
 const result=await api('/api/history/matches/run',{});
 assert.equal(result.status,201);
 const body=await result.json(); assert.equal(body.mode,'history_match');
 const row=await DB.prepare('SELECT body FROM jobs WHERE id=?').bind(body.id).first();
 const job=JSON.parse(row.body); assert.equal(job.mode,'history_match');assert.equal(job.folder,'Photos/Camera Roll');assert.equal(job.maxPhotos,100);assert.equal(job.progress.phase,'scanning');
});
test('history-only verification recovers a stopped stale run before starting again',async t=>{
 const {DB,api}=await setup(t);
 await api('/api/jobs',{folder:'Photos/Camera Roll',range:'3m',maxPhotos:50});
 await DB.prepare("UPDATE jobs SET status='complete'").bind().run();
 const first=await api('/api/history/matches/run',{}); assert.equal(first.status,201);
 const firstBody=await first.json();
 await DB.prepare("UPDATE jobs SET status='running',body=json_set(body,'$.stopRequested',json('true')) WHERE json_extract(body,'$.mode')='history_match'").bind().run();
 const second=await api('/api/history/matches/run',{}); assert.equal(second.status,201);
 const secondBody=await second.json(); assert.notEqual(secondBody.id,firstBody.id);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(firstBody.id).first()).status,'cancelled');
});
