import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, generateKeyPairSync, verify} from 'node:crypto';
import worker from '../worker/index.mjs';
import {cleanupInventories} from '../worker/inventory-state.mjs';
import {setup} from './helpers/database.mjs';

function bucket(){
 const objects=new Map();
 const checksum=async bytes=>crypto.subtle.digest('SHA-256',bytes);
 return {objects,async put(key,data,options){const bytes=new Uint8Array(await new Response(data).arrayBuffer());
   if(await hash(bytes)!==options.sha256)throw new Error('checksum_mismatch');
   objects.set(key,bytes);return {size:bytes.length,checksums:{sha256:await checksum(bytes)}};},
  async get(key){const bytes=objects.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),checksums:{sha256:await checksum(bytes)}}:null;},
  async head(key){const bytes=objects.get(key);return bytes?{size:bytes.length,checksums:{sha256:await checksum(bytes)}}:null;},
  async list(){return {objects:[...objects].map(([key])=>({key,uploaded:new Date(0)})),truncated:false};},
  async delete(key){objects.delete(key);}};
}
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const call=(env,method,path,body,headers={})=>worker.fetch(new Request('https://example.test'+path,{method,
 headers:{Authorization:'Bearer machine',...headers},body}),env);
const upload=async(env,bytes,headers={})=>call(env,'PUT','/internal/inventory',bytes,{
 'Content-Type':'application/zip','Content-Length':String(bytes.length),
 'X-Inventory-Sha256':await hash(bytes),...headers});

test('inventory seed and checked snapshots survive a new processor lease',async t=>{
 const {env,api,DB}=await setup(t);env.MEDIA_BUCKET=bucket();
 const seed=new Uint8Array([80,75,3,4,1]);
 assert.equal((await upload(env,seed,{'X-Inventory-Seed':'1'})).status,200);
 assert.equal((await upload(env,seed,{'X-Inventory-Seed':'1'})).status,409);
 assert.equal((await(await call(env,'GET','/internal/inventory/status')).json()).ready,true);
 await api('/api/jobs',{folder:'Photos',range:'all'});
 let job=await(await api('/internal/claim',{},true)).json();
 const headers={'X-Job-Id':job.id,'X-Job-Lease':job.lease};
 const previous=await call(env,'GET','/internal/inventory',undefined,headers);
 assert.deepEqual([...new Uint8Array(await previous.arrayBuffer())],[...seed]);
 const next=new Uint8Array([80,75,3,4,2]);
 const saved=await(await upload(env,next,headers)).json();
 const progress={phase:'scanning',total:1,processed:0,analyzed:0,batches:0};
 assert.equal((await api('/internal/checkpoint',{jobId:job.id,lease:job.lease,progress,inventoryRef:saved.ref},true)).status,200);
 assert.equal((await DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first()).value.includes(saved.ref),true);
 job=await(await api('/internal/claim',{},true)).json();
 const restored=await call(env,'GET','/internal/inventory',undefined,{'X-Job-Id':job.id,'X-Job-Lease':job.lease});
 assert.deepEqual([...new Uint8Array(await restored.arrayBuffer())],[...next]);
 assert.equal((await api('/internal/checkpoint',{jobId:job.id,lease:job.lease,progress},true)).status,400);
});

test('bad digest or wrong lease never advances the Cloudflare pointer',async t=>{
 const {env,api,DB}=await setup(t);env.MEDIA_BUCKET=bucket();
 const seed=new Uint8Array([80,75,3,4]);
 assert.equal((await upload(env,seed,{'X-Inventory-Seed':'1','X-Inventory-Sha256':'0'.repeat(64)})).status,400);
 assert.equal((await upload(env,seed,{'X-Inventory-Seed':'1'})).status,200);
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const job=await(await api('/internal/claim',{},true)).json();
 const before=(await DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first()).value;
 const saved=await(await upload(env,seed,{'X-Job-Id':job.id,'X-Job-Lease':job.lease})).json();
 const progress={phase:'scanning',total:0,processed:0,analyzed:0,batches:0};
 assert.equal((await api('/internal/checkpoint',{jobId:job.id,lease:'wrong',progress,inventoryRef:saved.ref},true)).status,409);
 assert.equal((await DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first()).value,before);
 await DB.prepare('UPDATE state SET expires=1 WHERE key=?').bind('inventory-stage:'+saved.ref).run();
 await cleanupInventories(env,8*86400000);
 assert.equal(env.MEDIA_BUCKET.objects.size,1);
 assert.ok([...env.MEDIA_BUCKET.objects.keys()][0].startsWith('inventories/'));
});


test('native snapshot commits the same inventory pointer without releasing the running lease',async t=>{
 const {env,api,DB}=await setup(t);env.MEDIA_BUCKET=bucket();
 const bytes=new Uint8Array([80,75,3,4,1]);
 await upload(env,bytes,{'X-Inventory-Seed':'1'});
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const job=await(await api('/internal/claim',{},true)).json();
 const before=await DB.prepare('SELECT lease,created FROM jobs WHERE id=?').bind(job.id).first();
 const saved=await(await upload(env,new Uint8Array([80,75,3,4,2]),{'X-Job-Id':job.id,'X-Job-Lease':job.lease})).json();
 const progress={phase:'scanning',total:0,processed:0,analyzed:0,batches:0};
 const body={jobId:job.id,lease:job.lease,progress,inventoryRef:saved.ref,nativeCheckpoint:true};
 assert.equal((await api('/internal/checkpoint',body,true)).status,200);
 const running=await DB.prepare('SELECT lease,status,created FROM jobs WHERE id=?').bind(job.id).first();
 assert.equal(running.lease,before.lease);assert.equal(running.created,before.created);assert.equal(running.status,'running');
 assert.ok((await DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first()).value.includes(saved.ref));
 assert.equal(await(await api('/internal/claim',{},true)).json(),null);
 const next=await(await upload(env,new Uint8Array([80,75,3,4,3]),{'X-Job-Id':job.id,'X-Job-Lease':job.lease})).json();
 assert.equal((await api('/internal/checkpoint',{...body,inventoryRef:next.ref,nativeCheckpoint:false},true)).status,200);
 const released=await DB.prepare('SELECT lease,status FROM jobs WHERE id=?').bind(job.id).first();
 assert.equal(released.lease,null);assert.equal(released.status,'pending');
 const resumed=await(await api('/internal/claim',{},true)).json();assert.equal(resumed.id,job.id);assert.notEqual(resumed.lease,job.lease);
});

for (const dispatchStatus of [204, 502]) {
test(`signed Muse completion claims its parked job once after GitHub ${dispatchStatus}`, async t => {
 const {env,api,DB}=await setup(t);env.MEDIA_BUCKET=bucket();
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 Object.assign(env,{
   SCREEN_COMPLETION_SECRET:'local-fixture-completion-key'.repeat(2),
   SCREEN_RESUME_APP_ID:'1',SCREEN_RESUME_INSTALLATION_ID:'2',
   SCREEN_RESUME_APP_KEY:privateKey.export({type:'pkcs8',format:'pem'}),
 });
 const posts=[];
 const dispatchEntered=Promise.withResolvers();
 const githubReply=Promise.withResolvers();
 t.mock.method(globalThis,'fetch',async (target,options)=>{
   const credential=options.headers.Authorization;
   const url=new URL(target);
   posts.push({url,body:JSON.parse(options.body)});
   if (url.pathname.endsWith('/access_tokens')) {
     const [header,claims,signature]=credential.slice('Bearer '.length).split('.');
     assert.ok(verify('RSA-SHA256',Buffer.from(header+'.'+claims),publicKey,Buffer.from(signature,'base64url')));
     const decoded=JSON.parse(Buffer.from(claims,'base64url'));
     assert.equal(decoded.iss,'1');
     assert.ok(decoded.exp-decoded.iat<=600);
     return posts.length===1?new Response(null,{status:503})
       :Response.json({token:'synthetic-installation-token'},{status:201});
   }
   assert.equal(credential,'Bearer synthetic-installation-token');
   dispatchEntered.resolve();
   return githubReply.promise;
 });
 const taskId='01010101-0101-0101-0101-010101010101';
 const event={name:'task.terminal',event_id:5,task_id:taskId,revision:1,project:'Pigbibi/PhotoStory',status:'completed'};
 const webhook=(payload=event, stamp=Math.floor(Date.now()/1000), signature=null)=>{
   const body=JSON.stringify(payload);
   const mac=signature??createHmac('sha256',env.SCREEN_COMPLETION_SECRET).update(stamp+'.'+body).digest('hex');
   return worker.fetch(new Request('https://example.test/internal/screen-completed',{method:'POST',body,
     headers:{'X-Callback-Timestamp':String(stamp),'X-Callback-Signature':'sha256='+mac}}),
   env,{});
 };
 assert.equal((await webhook(event,Math.floor(Date.now()/1000),'0'.repeat(64))).status,401);
 assert.equal((await webhook(event,Math.floor(Date.now()/1000)-600)).status,401);
 assert.equal((await webhook({...event,project:'Other/Project'})).status,400);
 assert.equal((await webhook()).status,503);
 assert.equal(posts.length,0);

 const bytes=new Uint8Array([80,75,3,4,1]);
 await upload(env,bytes,{'X-Inventory-Seed':'1'});
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const job=await(await api('/internal/claim',{},true)).json();
 const saved=await(await upload(env,bytes,{'X-Job-Id':job.id,'X-Job-Lease':job.lease})).json();
 const progress={phase:'processing',total:1,processed:0,analyzed:0,batches:0};
 const parked={jobId:job.id,lease:job.lease,progress,inventoryRef:saved.ref,screenWait:{taskId,revision:1}};
 assert.equal((await api('/internal/checkpoint',parked,true)).status,200);
 const wake=JSON.parse((await DB.prepare('SELECT body FROM jobs WHERE id=?').bind(job.id).first()).body).screenWait.wake;
 assert.equal(await (await api('/internal/claim',{resumeScreen:wake,pilotJob:job.id},true)).json(),null);
 assert.equal((await webhook({...event,revision:2})).status,503);
 // The first mint failed, so the same signed event may retry safely.
 assert.equal((await webhook()).status,503);
 assert.equal(posts.length,1);
 let acknowledged=false;
 const delivery=webhook().then(response=>{
   acknowledged=true;
   return response;
 });
 await dispatchEntered.promise;
 // While the first dispatch is outstanding a duplicate starts no new run.
 assert.equal((await webhook()).status,503);
 assert.equal(acknowledged,false);
 githubReply.resolve(new Response(null,{status:dispatchStatus}));
 assert.equal((await delivery).status,dispatchStatus===204?202:409);
 assert.equal((await webhook()).status,dispatchStatus===204?200:409);
 assert.equal(posts.length,3);
 assert.equal(posts[0].url.pathname,'/app/installations/2/access_tokens');
 assert.deepEqual(posts[0].body,{repositories:['PhotoStory'],permissions:{actions:'write'}});
 assert.equal(posts[2].url.pathname,'/repos/Pigbibi/PhotoStory/actions/workflows/processor.yml/dispatches');
 assert.deepEqual(posts[2].body,{ref:'main',inputs:{resume_screen:wake}});
 assert.equal(await (await api('/internal/claim',{resumeScreen:'1'.repeat(64),pilotJob:job.id},true)).json(),null);
 assert.equal(await (await api('/internal/claim',{resumeScreen:wake,pilotJob:'other-job'},true)).json(),null);
 const resumed=await(await api('/internal/claim',{resumeScreen:wake,pilotJob:job.id},true)).json();
 assert.equal(resumed.id,job.id);
 assert.notEqual(resumed.lease,job.lease);
 assert.equal(await (await api('/internal/claim',{resumeScreen:wake,pilotJob:job.id},true)).json(),null);
 const staged=await(await upload(env,bytes,{'X-Job-Id':resumed.id,'X-Job-Lease':resumed.lease})).json();
 const completion={jobId:resumed.id,lease:resumed.lease,inventoryRef:staged.ref,batchId:'batch',more:false,
   progress:{phase:'complete',total:1,processed:1,analyzed:1,batches:1},
   drafts:[{id:resumed.id+'-batch-landscape-0-1',title:'Scenery',caption:'For review',photos:[{id:'p'}]}],
   photos:[{id:'p',safety:'allow',flags:[],jpeg:'/9j/'}],autoReviews:[],crossReviews:[]};
 assert.equal((await api('/internal/complete',completion,true)).status,200);
 assert.equal((await api('/internal/complete',completion,true)).status,409);
 const savedDrafts=(await DB.prepare('SELECT body FROM drafts').all()).results;
 assert.equal(savedDrafts.length,1);
 assert.equal(JSON.parse(savedDrafts[0].body).status,'draft');
});
}

test('native snapshot rejects malformed flags and owner stop without pointer or lease changes',async t=>{
 const {env,api,DB}=await setup(t);env.MEDIA_BUCKET=bucket();
 await upload(env,new Uint8Array([80,75,3,4,1]),{'X-Inventory-Seed':'1'});
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const job=await(await api('/internal/claim',{},true)).json();
 const saved=await(await upload(env,new Uint8Array([80,75,3,4,2]),{'X-Job-Id':job.id,'X-Job-Lease':job.lease})).json();
 const before=(await DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first()).value;
 const body={jobId:job.id,lease:job.lease,progress:{phase:'scanning',total:0,processed:0,analyzed:0,batches:0},inventoryRef:saved.ref,nativeCheckpoint:'yes'};
 assert.equal((await api('/internal/checkpoint',body,true)).status,400);
 await DB.prepare("UPDATE jobs SET body=json_set(body,'$.stopRequested',json('true')) WHERE id=?").bind(job.id).run();
 assert.equal((await api('/internal/checkpoint',{...body,nativeCheckpoint:true},true)).status,400);
 assert.equal((await DB.prepare("SELECT value FROM state WHERE key='inventory-current'").first()).value,before);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(job.id).first()).status,'running');
 assert.equal((await api('/internal/checkpoint',{...body,nativeCheckpoint:false},true)).status,200);
 assert.equal((await DB.prepare('SELECT status FROM jobs WHERE id=?').bind(job.id).first()).status,'cancelled');
});
