import test from 'node:test';
import assert from 'node:assert/strict';
import {jpegDimensions} from '../worker/publishing.mjs';
// Baseline JPEG header with a 1080 x 1350 SOF0 and no metadata.
const jpeg=()=>new Uint8Array([255,216,255,192,0,17,8,5,70,4,56,3,1,17,0,2,17,0,3,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);
test('publishing only accepts bounded EXIF-free JPEGs at the approved canvas size',()=>{
 assert.deepEqual(jpegDimensions(jpeg()),{width:1080,height:1350});
 const icc=new Uint8Array([255,216,255,226,0,16,...new TextEncoder().encode('ICC_PROFILE\0'),1,1,...jpeg().slice(2)]);
 assert.deepEqual(jpegDimensions(icc),{width:1080,height:1350});
 const exif=new Uint8Array([255,216,255,225,0,8,69,120,105,102,0,0,...jpeg().slice(2)]);
 assert.throws(()=>jpegDimensions(exif),/invalid_publish_image/);
 assert.throws(()=>jpegDimensions(new Uint8Array([1,2,3])),/invalid_publish_image/);
});
import {setup} from './helpers/database.mjs';
import {seal,put} from '../worker/auth.mjs';
import * as pub from '../worker/publishing.mjs';
async function fixture(t,count=2){
 const v=await setup(t);Object.assign(v.env,{INSTAGRAM_CLIENT_ID:'1234',INSTAGRAM_CLIENT_SECRET:'fixture',INSTAGRAM_USERNAME:'landscapes',INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',TOKEN_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))});
 await put(v.env,'instagram',await seal(v.env,{access:'private-token',client:'1234',userId:'456',scopedId:'123',username:'landscapes',permissions:['instagram_business_basic','instagram_business_content_publish'],expires:Date.now()+3600000}));
 const d={id:'d',version:1,status:'approved',title:'Coast',caption:'A coast.',hashtags:'#Coast',aspect:'4:5',photos:Array.from({length:count},(_,i)=>({id:'p'+i,alt:'Coast',frame:{mode:'fit',x:50,y:50}}))};
 await v.DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind('d',JSON.stringify(d)).run();return {...v,d};
}
test('approved images stay private until explicit publication and only publish once in order',async t=>{
 const {env,d}=await fixture(t);const p=await pub.prepare(env,'d',1);let creates=0,publishes=0;const children=[];
 for(const photo of d.photos)await pub.upload(env,'d',p.id,photo.id,jpeg());
 assert.equal((await pub.media(env,p.id,'p0')).status,404);
 t.mock.method(globalThis,'fetch',async(url,o)=>{
  assert.equal(o.headers.Authorization,'Bearer private-token');assert.equal(o.redirect,'manual');assert.ok(!String(url).includes('private-token'));
  if(o.method==='POST'&&String(url).endsWith('/media')){creates++;if(o.body.get('media_type')==='CAROUSEL')assert.equal(o.body.get('children'),'101,102');else {assert.equal(o.body.get('alt_text'),'Coast');children.push(o.body.get('image_url'));}return Response.json({id:String(100+creates)});}
  if(o.method==='POST'){publishes++;assert.equal(o.body.get('creation_id'),'103');return Response.json({id:'900'});}
  return Response.json({status_code:'FINISHED'});
 });
 await pub.begin(env,'d',p.id,1,'landscapes');
 assert.equal((await pub.media(env,p.id,'p0')).status,200);
 for(let i=0;i<10;i++){const s=await pub.advance(env,'d',p.id);if(s.status==='published')break;}
 const result=await pub.view(env,'d');assert.equal(result.status,'published');assert.equal(result.mediaId,'900');assert.equal(publishes,1);assert.equal(creates,3);
 assert.ok(children[0].endsWith('/p0'));assert.ok(children[1].endsWith('/p1'));
 await assert.rejects(pub.begin(env,'d',p.id,1,'landscapes'),/publication_conflict/);
 await pub.advance(env,'d',p.id);assert.equal(publishes,1);
});
test('incomplete uploads and changed approval cannot begin publication',async t=>{
 const {env,DB}=await fixture(t);const p=await pub.prepare(env,'d',1);
 await assert.rejects(pub.begin(env,'d',p.id,1,'landscapes'),/publication_incomplete/);
 await pub.upload(env,'d',p.id,'p0',jpeg());await pub.upload(env,'d',p.id,'p1',jpeg());
 await DB.prepare("UPDATE drafts SET body=json_set(body,'$.status','draft') WHERE id='d'").bind().run();
 await assert.rejects(pub.begin(env,'d',p.id,1,'landscapes'),/approval_required/);
});
test('ambiguous publish response is durable and is never retried',async t=>{
 const {env}=await fixture(t,1);const p=await pub.prepare(env,'d',1);await pub.upload(env,'d',p.id,'p0',jpeg());await pub.begin(env,'d',p.id,1,'landscapes');let publishes=0;
 t.mock.method(globalThis,'fetch',async(url,o)=>{
  if(String(url).endsWith('/media_publish')){publishes++;throw new Error('secret provider detail');}
  return Response.json(o.method==='POST'?{id:'101'}:{status_code:'FINISHED'});
 });
 await pub.advance(env,'d',p.id);await pub.advance(env,'d',p.id);const result=await pub.advance(env,'d',p.id);
 assert.equal(result.status,'uncertain');assert.ok(!JSON.stringify(result).includes('secret'));
 await pub.advance(env,'d',p.id);assert.equal(publishes,1);
});
import worker from '../worker/index.mjs';
test('owner API protects publication routes and locks edits after begin',async t=>{
 const {env,d}=await fixture(t,1);const p=await pub.prepare(env,'d',1);await pub.upload(env,'d',p.id,'p0',jpeg());
 const url='https://example.test/api/publish/d/'+p.id+'/begin';
 assert.equal((await worker.fetch(new Request(url,{method:'POST',body:'{}'}),env)).status,401);
 assert.equal((await worker.fetch(new Request(url,{method:'POST',headers:{Cookie:'__Host-photostory=session',Origin:'https://evil.invalid'},body:'{}'}),env)).status,403);
 await pub.begin(env,'d',p.id,1,'landscapes');
 const edit=await worker.fetch(new Request('https://example.test/api/drafts/d',{method:'PATCH',headers:{Cookie:'__Host-photostory=session',Origin:'https://example.test'},body:JSON.stringify({...d,action:'save',caption:'Changed'})}),env);
 assert.equal(edit.status,409);assert.equal((await pub.view(env,'d')).status,'publishing');
});
test('expired images are inaccessible and cleaned without deleting publication history',async t=>{
 const {env,DB}=await fixture(t,1);const p=await pub.prepare(env,'d',1);await pub.upload(env,'d',p.id,'p0',jpeg());await pub.begin(env,'d',p.id,1,'landscapes');
 await DB.prepare('UPDATE publications SET expires=0 WHERE id=?').bind(p.id).run();
 assert.equal((await pub.media(env,p.id,'p0')).status,404);
 await pub.cleanup(env);assert.equal((await DB.prepare('SELECT count(*) AS n FROM publication_images').first()).n,0);
 assert.ok(await pub.view(env,'d'));
});
test('an in-flight claim cannot be duplicated by another advance request',async t=>{
 const {env}=await fixture(t,1);const p=await pub.prepare(env,'d',1);await pub.upload(env,'d',p.id,'p0',jpeg());await pub.begin(env,'d',p.id,1,'landscapes');let calls=0,release,started;
 const called=new Promise(r=>started=r),blocked=new Promise(r=>release=r);
 t.mock.method(globalThis,'fetch',async()=>{calls++;started();await blocked;return Response.json({id:'101'});});
 const first=pub.advance(env,'d',p.id);await called;
 assert.equal((await pub.advance(env,'d',p.id)).status,'working');assert.equal(calls,1);
 release();await first;assert.equal(calls,1);
});

test('unfinished containers are polled at most once per minute',async t=>{
 const {env}=await fixture(t,1);const p=await pub.prepare(env,'d',1);await pub.upload(env,'d',p.id,'p0',jpeg());await pub.begin(env,'d',p.id,1,'landscapes');let calls=0;
 t.mock.method(globalThis,'fetch',async(url,o)=>{calls++;return Response.json(o.method==='POST'?{id:'101'}:{status_code:'IN_PROGRESS'});});
 await pub.advance(env,'d',p.id);const waiting=await pub.advance(env,'d',p.id);
 assert.ok(waiting.retryAfterMs>0);await pub.advance(env,'d',p.id);assert.equal(calls,2);
});

test('permission errors retain safe diagnostics and never retry',async t=>{
 const {env,d,DB}=await fixture(t,1);const p=await pub.prepare(env,'d',1);
 await pub.upload(env,'d',p.id,d.photos[0].id,jpeg());await pub.begin(env,'d',p.id,1,'landscapes');
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:{code:200,error_subcode:123,message:'private-token https://secret.example',error_data:{token:'private'}}},{status:400});});
 const result=await pub.advance(env,'d',p.id);
 assert.equal(result.failure.category,'authorization');assert.equal(result.failure.stage,'create_image');assert.equal(result.failure.code,200);assert.equal(result.failure.httpStatus,400);
 assert.ok(Number.isSafeInteger(result.failure.at));
 const stored=(await DB.prepare('SELECT body FROM publications').first()).body;
 assert.ok(!stored.includes('private-token'));assert.ok(!stored.includes('secret.example'));
 await pub.advance(env,'d',p.id);assert.equal(calls,1);
 assert.equal((await pub.issue(env)).failure.code,200);
});

test('read-only account check reports authorization errors without creating media',async t=>{
 const {env}=await fixture(t);const {publishingHealth}=await import('../worker/instagram.mjs');let calls=0;
 t.mock.method(globalThis,'fetch',async(url,o)=>{calls++;assert.ok(!o.method||o.method==='GET');return Response.json({error:{code:200,message:'private-token'}},{status:400});});
 const result=await publishingHealth(env);assert.equal(result.ok,false);assert.equal(result.category,'authorization');assert.equal(result.code,200);assert.ok(!JSON.stringify(result).includes('private-token'));assert.equal(calls,1);
});

test('owner recovery is limited to one settled first-container failure with intact images',async t=>{
 const {env,DB,d}=await fixture(t,1);const p=await pub.prepare(env,'d',1);
 await pub.upload(env,'d',p.id,d.photos[0].id,jpeg());await pub.begin(env,'d',p.id,1,'landscapes');
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:200}},{status:400}));await pub.advance(env,'d',p.id);
 await assert.rejects(pub.recover(env,'d',p.id,1,'landscapes'),/publication_conflict/);
 await DB.prepare("UPDATE publications SET body=json_set(body,'$.touched',?)").bind(Date.now()-130000).run();
 t.mock.method(globalThis,'fetch',async()=>Response.json({id:'123',username:'landscapes'}));
 const recovered=await pub.recover(env,'d',p.id,1,'landscapes');assert.equal(recovered.status,'publishing');
 const body=JSON.parse((await DB.prepare('SELECT body FROM publications').first()).body);assert.equal(body.recoveries.length,1);assert.equal(body.recoveries[0].failure.code,200);
 await DB.prepare("UPDATE publications SET status='uncertain',body=json_set(body,'$.touched',?)").bind(Date.now()-130000).run();
 await assert.rejects(pub.recover(env,'d',p.id,1,'landscapes'),/publication_conflict/);
});

test('owner recovery cannot replay a later or possibly published operation',async t=>{
 const {env,DB,d}=await fixture(t,1);const p=await pub.prepare(env,'d',1);await pub.upload(env,'d',p.id,d.photos[0].id,jpeg());
 await DB.prepare("UPDATE publications SET status='uncertain',body=json_set(body,'$.touched',?,'$.parent','100','$.ready',1)").bind(Date.now()-130000).run();
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not call')});
 await assert.rejects(pub.recover(env,'d',p.id,1,'landscapes'),/publication_conflict/);assert.equal(calls,0);
});
