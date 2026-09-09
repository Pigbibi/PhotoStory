import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import {hash,seal} from '../worker/auth.mjs';
import {original,downloadHost} from '../worker/originals.mjs';
import worker from '../worker/index.mjs';
async function fixture(t){
 const v=await setup(t),{env,DB}=v;
 env.TOKEN_ENCRYPTION_KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
 await DB.prepare("UPDATE state SET value=? WHERE key='microsoft'").bind(JSON.stringify(await seal(env,{access:'fixture-token',expires:Date.now()+3600000}))).run();
 const pid=await hash('drive:item'),version=await hash(pid+'\0v1');
 await DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind('d',JSON.stringify({id:'d',version:1,status:'approved',photos:[{id:pid}]})).run();
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('photo-source:'+pid,JSON.stringify({item:'item',version})).run();
 return {...v,pid};
}
test('download URLs reject arbitrary hosts, userinfo, ports and lookalikes',()=>{
 for(const url of ['http://files.1drv.com/x','https://evil.invalid','https://files.1drv.com.evil.invalid','https://u@files.1drv.com/x','https://files.1drv.com:444/x'])assert.equal(downloadHost(url),false);
 assert.equal(downloadHost('https://files.1drv.com/x'),true);
});
test('original requires current approval and never leaks bearer token to download host',async t=>{
 const {env,DB,pid}=await fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls++;
  if(url.startsWith('https://graph.microsoft.com/')){assert.equal(options.headers.Authorization,'Bearer fixture-token');return Response.json({id:'item',parentReference:{driveId:'drive'},eTag:'v1',size:3,file:{mimeType:'image/jpeg'},image:{width:2000,height:1000},'@microsoft.graph.downloadUrl':'https://files.1drv.com/x'});}
  assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');return new Response(new Uint8Array([255,216,255]));
 });
 const r=await original(env,'d',pid,1);assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,3);assert.equal(calls,3);
 await assert.rejects(original(env,'d',pid,2),/version_conflict/);
 await DB.prepare("UPDATE drafts SET body=json_set(body,'$.status','draft') WHERE id='d'").bind().run();
 await assert.rejects(original(env,'d',pid,1),/approval_required/);assert.equal(calls,3);
});
test('changed original or revoked approval during download prevents delivery',async t=>{
 const {env,DB,pid}=await fixture(t);let metaCalls=0,changed=true;
 t.mock.method(globalThis,'fetch',async(url)=>{
  if(url.startsWith('https://graph.microsoft.com/'))return Response.json({id:'item',parentReference:{driveId:'drive'},eTag:++metaCalls>1&&changed?'v2':'v1',size:3,file:{mimeType:'image/jpeg'},image:{width:2000,height:1000},'@microsoft.graph.downloadUrl':'https://files.1drv.com/x'});
  if(!changed)await DB.prepare("UPDATE drafts SET body=json_set(body,'$.status','draft') WHERE id='d'").bind().run();
  return new Response(new Uint8Array([255,216,255]));
 });
 await assert.rejects(original(env,'d',pid,1),/source_changed/);metaCalls=0;changed=false;
 await assert.rejects(original(env,'d',pid,1),/approval_required/);
});
test('original API is private and accepts only same-origin POST requests',async t=>{
 const {env,pid}=await fixture(t);const path='https://example.test/api/export/d/'+pid;
 const r=await worker.fetch(new Request(path,{method:'POST',body:JSON.stringify({version:1})}),env);assert.equal(r.status,401);
 const cross=await worker.fetch(new Request(path,{method:'POST',headers:{Cookie:'__Host-photostory=session',Origin:'https://evil.invalid'},body:'{}'}),env);assert.equal(cross.status,403);
});
test('legacy source recovery checks original identity and the scanned version fingerprint',async t=>{
 const {recoverSource}=await import('../worker/originals.mjs');const {env,pid}=await fixture(t);
 const policy='a'.repeat(64),fingerprint=await hash(policy+await hash(pid+'\0v1'));
 t.mock.method(globalThis,'fetch',async()=>Response.json({id:'item',eTag:'v1',parentReference:{driveId:'drive'}}));
 assert.deepEqual(await recoverSource(env,pid,'item',fingerprint,policy),{item:'item',version:await hash(pid+'\0v1')});
 await assert.rejects(recoverSource(env,pid,'item','b'.repeat(64),policy),/source_changed/);
 await assert.rejects(recoverSource(env,'c'.repeat(64),'item',fingerprint,policy),/source_changed/);
});
