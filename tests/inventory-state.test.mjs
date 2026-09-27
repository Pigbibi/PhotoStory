import test from 'node:test';
import assert from 'node:assert/strict';
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
