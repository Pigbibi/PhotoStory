import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import {storeImage,readImage,storageView,migrateImages,cleanupImages} from '../worker/storage.mjs';
function bucket(){
 const objects=new Map();
 return {objects,async put(key,data){const bytes=new Uint8Array(data).slice();objects.set(key,bytes);return {size:bytes.length};},async get(key){const data=objects.get(key);return data?{size:data.length,arrayBuffer:async()=>data.slice().buffer,body:new Blob([data]).stream()}:null;},async delete(key){objects.delete(key);}};
}
async function fixture(t,limit=100){const v=await setup(t);v.env.MEDIA_BUCKET=bucket();v.env.STORAGE_MAX_BYTES=String(limit);return v;}
test('R2 writes reserve capacity atomically and keep existing images readable at the cap',async t=>{
 const {env}=await fixture(t,3);
 await storeImage(env,'preview:p',new Uint8Array([1,2,3]));
 await assert.rejects(storeImage(env,'preview:q',new Uint8Array([4])),/storage_limit/);
 assert.deepEqual([...new Uint8Array(await (await readImage(env,'preview:p',new Uint8Array())).arrayBuffer())],[1,2,3]);
 assert.equal((await storageView(env)).usedBytes,3);
});
test('migration verifies each R2 copy before replacing only its original D1 bytes',async t=>{
 const {env,DB}=await fixture(t);
 await DB.prepare('INSERT INTO photos VALUES(?,?,?)').bind('p',new Uint8Array([1,2,3]).buffer,'image/jpeg').run();
 assert.equal((await migrateImages(env)).migrated,1);
 assert.equal((await DB.prepare('SELECT length(data) AS n FROM photos').first()).n,0);
 assert.equal((await migrateImages(env)).migrated,0);
 assert.equal((await storageView(env)).usedBytes,3);
});
test('corrupt copy leaves the original D1 image intact',async t=>{
 const {env,DB}=await fixture(t);
 await DB.prepare('INSERT INTO photos VALUES(?,?,?)').bind('p',new Uint8Array([1,2,3]).buffer,'image/jpeg').run();
 env.MEDIA_BUCKET.get=async()=>({size:3,arrayBuffer:async()=>new Uint8Array([9,9,9]).buffer});
 await assert.rejects(migrateImages(env),/storage_unavailable/);
 assert.equal((await DB.prepare('SELECT length(data) AS n FROM photos').first()).n,3);
});
test('an ambiguous PUT retains capacity and is never blindly repeated',async t=>{
 const {env}=await fixture(t);let calls=0;
 env.MEDIA_BUCKET.put=async()=>{calls++;throw new Error('private provider error');};
 await assert.rejects(storeImage(env,'preview:p',new Uint8Array([1,2,3])),/^Error: storage_unavailable$/);
 await assert.rejects(storeImage(env,'preview:p',new Uint8Array([1,2,3])),/storage_busy/);
 assert.equal(calls,1);assert.equal((await storageView(env)).usedBytes,3);
 await cleanupImages(env,Date.now()+2*86400000);assert.equal((await storageView(env)).usedBytes,3);
});
test('parallel reservations cannot exceed the byte budget',async t=>{
 const {env}=await fixture(t,5);
 const results=await Promise.allSettled(['a','b'].map(id=>storeImage(env,'preview:'+id,new Uint8Array([1,2,3]))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await storageView(env)).usedBytes,3);
});
test('monthly request caps stop writes without losing already committed images',async t=>{
 const {env}=await fixture(t);env.STORAGE_WRITE_LIMIT='1';env.STORAGE_READ_LIMIT='1';
 await storeImage(env,'preview:p',new Uint8Array([1,2,3]));
 await assert.rejects(storeImage(env,'preview:q',new Uint8Array([1])),/storage_request_limit/);
 assert.equal((await storageView(env)).usedBytes,3);
 await readImage(env,'preview:p',[]);
 await assert.rejects(readImage(env,'preview:p',[]),/storage_request_limit/);
 assert.equal(env.MEDIA_BUCKET.objects.size,1);
});
test('cleanup keeps referenced previews, removes expired delivery, and releases capacity only after deletion',async t=>{
 const {env,DB}=await fixture(t);
 await storeImage(env,'preview:p',new Uint8Array([1,2,3]));
 await DB.prepare("INSERT INTO photos VALUES('p',X'','image/jpeg')").bind().run();
 await storeImage(env,'preview:orphan',new Uint8Array([1]));
 await storeImage(env,'publication:pub:p',new Uint8Array([1,2]));
 await DB.prepare("INSERT INTO publications VALUES('d','pub',1,'prepared','{}',0,1)").bind().run();
 await cleanupImages(env,Date.now()+2*86400000);
 assert.equal((await storageView(env)).usedBytes,3);assert.equal(env.MEDIA_BUCKET.objects.size,1);
});
import worker from '../worker/index.mjs';
import * as pub from '../worker/publishing.mjs';
test('R2 previews require owner login and delivery still requires an active unexpired publication',async t=>{
 const {env,DB}=await fixture(t);
 await storeImage(env,'preview:p',new Uint8Array([1,2,3]));
 await DB.prepare("INSERT INTO photos VALUES('p',X'','image/jpeg')").bind().run();
 assert.equal((await worker.fetch(new Request('https://example.test/api/photos/p'),env)).status,401);
 const r=await worker.fetch(new Request('https://example.test/api/photos/p',{headers:{Cookie:'__Host-photostory=session'}}),env);
 assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[1,2,3]);
 await storeImage(env,'publication:pub:p',new Uint8Array([4,5]));
 await DB.prepare("INSERT INTO publications VALUES('d','pub',1,'prepared','{}',0,?)").bind(Date.now()+3600000).run();
 await DB.prepare("INSERT INTO publication_images VALUES('pub','p',X'','digest')").bind().run();
 assert.equal((await pub.media(env,'pub','p')).status,404);
 await DB.prepare("UPDATE publications SET status='publishing' WHERE id='pub'").bind().run();
 assert.deepEqual([...new Uint8Array(await (await pub.media(env,'pub','p')).arrayBuffer())],[4,5]);
 await DB.prepare("UPDATE publications SET expires=0 WHERE id='pub'").bind().run();
 assert.equal((await pub.media(env,'pub','p')).status,404);
});
test('disabled R2 cannot silently serve empty blobs or overwrite missing objects',async t=>{
 const {env}=await fixture(t);
 await storeImage(env,'preview:p',new Uint8Array([1]));env.MEDIA_BUCKET=null;env.MEDIA_STORAGE='r2';
 await assert.rejects(readImage(env,'preview:p',[]),/storage_unavailable/);
});
