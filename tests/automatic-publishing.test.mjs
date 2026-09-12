import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,settingsInput} from '../worker/lifecycle.mjs';
import {setup} from './helpers/database.mjs';

test('publishing defaults to manual independently of strict AI approval',()=>{
 assert.equal(defaults.publishMode,'manual');
 assert.equal(settingsInput({...defaults,reviewMode:'strict_auto'}).publishMode,'manual');
 assert.throws(()=>settingsInput({...defaults,publishMode:'automatic'}),/invalid_settings/);
 assert.equal(settingsInput({...defaults,reviewMode:'strict_auto',publishMode:'automatic'}).publishMode,'automatic');
});
test('machine cannot request an automatic candidate while publishing is manual',async t=>{
 const {api}=await setup(t);
 const result=await api('/internal/autopublish',{action:'candidate'},true);
 assert.equal(result.status,200);assert.equal(await result.json(),null);
});

import {seal,put} from '../worker/auth.mjs';
import {automatic,eligible} from '../worker/automatic-publishing.mjs';
import * as pub from '../worker/publishing.mjs';
const jpeg=()=>new Uint8Array([255,216,255,192,0,17,8,2,208,4,56,3,1,17,0,2,17,0,3,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);
const review={privacySafe:true,captionGrounded:true,locationGrounded:true,coherent:true,compositionGood:true,noDuplicateFrames:true,needsHumanReview:false};
async function fixture(t){
 const v=await setup(t);Object.assign(v.env,{INSTAGRAM_CLIENT_ID:'1234',INSTAGRAM_CLIENT_SECRET:'fixture',INSTAGRAM_USERNAME:'landscapes',INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',TOKEN_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))});
 await put(v.env,'instagram',await seal(v.env,{access:'fixture-token',client:'1234',userId:'456',username:'landscapes',permissions:['instagram_business_basic','instagram_business_content_publish'],expires:Date.now()+3600000}));
 const s={...defaults,publishMode:'automatic',reviewMode:'strict_auto',autoPublishSince:Date.now()-1000,autoPublishUserId:'456'};
 await put(v.env,'automation',s);
 const d={id:'d',version:1,status:'approved',approvalSource:'strict_ai_v1',autoApprovedAt:Date.now(),title:'Coast',caption:'A coast.',hashtags:'#Coast',aspect:'3:2',photos:[{id:'p',alt:'Coast',frame:{mode:'crop',x:50,y:50}}]};
 await v.DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind('d',JSON.stringify(d)).run();return {...v,d,s};
}
test('legacy, manual, pre-enable and fitted drafts never qualify',()=>{
 const s={publishMode:'automatic',reviewMode:'strict_auto',autoPublishSince:100};
 const d={status:'approved',approvalSource:'strict_ai_v1',autoApprovedAt:101,photos:[{frame:{mode:'crop'}}]};
 assert.equal(eligible(d,s),true);
 for(const x of [{...d,autoApprovedAt:undefined},{...d,autoApprovedAt:100},{...d,approvalSource:undefined},{...d,status:'draft'},{...d,photos:[{frame:{mode:'fit'}}]}])assert.equal(eligible(x,s),false);
});
test('automatic preparation is single-claim and never replays an abandoned preparation',async t=>{
 const {env,DB}=await fixture(t);
 const p=await automatic(env,{action:'candidate'});assert.equal(p.draft.id,'d');
 assert.equal(await automatic(env,{action:'candidate'}),null);
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM publications').first()).n,1);
 await assert.rejects(pub.begin(env,'d',p.publication.id,1,'landscapes'),/publication_conflict/);
});
test('final review binds exact images, then publishes once; manual switch stops requests',async t=>{
 const {env,DB}=await fixture(t);const candidate=await automatic(env,{action:'candidate'});
 const auth={draftId:'d',version:1,publicationId:candidate.publication.id};
 await automatic(env,{...auth,action:'upload',photoId:'p',data:Buffer.from(jpeg()).toString('base64')});
 const digest=(await DB.prepare('SELECT digest FROM publication_images').first()).digest;
 const images=[{id:'p',digest}];
 await assert.rejects(automatic(env,{...auth,action:'begin',review,images:[{id:'p',digest:'bad'}]}),/publication_conflict/);
 await assert.rejects(automatic(env,{...auth,action:'begin',review:{...review,needsHumanReview:true},images}),/publication_conflict/);
 await automatic(env,{...auth,action:'begin',review,images});
 let writes=0;
 t.mock.method(globalThis,'fetch',async(url,o)=>{writes++;return Response.json(o.method==='POST'?{id:'101'}:{status_code:'FINISHED'});});
 await automatic(env,{...auth,action:'advance'});assert.equal(writes,1);
 await DB.prepare("UPDATE state SET value=json_set(value,'$.publishMode','manual') WHERE key='automation'").bind().run();
 await assert.rejects(automatic(env,{...auth,action:'advance'}),/publication_conflict/);
 await assert.rejects(pub.advance(env,'d',auth.publicationId),/publication_conflict/);
 assert.equal(writes,1);
});
test('automatic flow completes through timer calls without a browser and never duplicates a post',async t=>{
 const {env,DB}=await fixture(t);const candidate=await automatic(env,{action:'candidate'});
 const auth={draftId:'d',version:1,publicationId:candidate.publication.id};
 await automatic(env,{...auth,action:'upload',photoId:'p',data:Buffer.from(jpeg()).toString('base64')});
 const digest=(await DB.prepare('SELECT digest FROM publication_images').first()).digest;
 await automatic(env,{...auth,action:'begin',review,images:[{id:'p',digest}]});
 let publishes=0;
 t.mock.method(globalThis,'fetch',async(url,o)=>{if(String(url).endsWith('/media_publish'))publishes++;return Response.json(o.method==='POST'?{id:'101'}:{status_code:'FINISHED'});});
 for(let i=0;i<3;i++){assert.ok(await automatic(env,{action:'candidate'}));await automatic(env,{...auth,action:'advance'});}
 assert.equal((await pub.view(env,'d')).status,'published');assert.equal(publishes,1);
 assert.equal(await automatic(env,{action:'candidate'}),null);
 await automatic(env,{...auth,action:'advance'});assert.equal(publishes,1);
});
test('global ambiguity blocks even new eligible drafts',async t=>{
 const {env,DB}=await fixture(t);
 await DB.prepare("INSERT INTO publications VALUES('other','other',1,'uncertain','{}',0,0)").bind().run();
 assert.equal(await automatic(env,{action:'candidate'}),null);
});
test('rejected original review returns the draft to human review and is not reclaimed',async t=>{
 const {env,DB}=await fixture(t);const c=await automatic(env,{action:'candidate'});
 await automatic(env,{action:'reject',draftId:'d',version:1,publicationId:c.publication.id});
 const d=JSON.parse((await DB.prepare("SELECT body FROM drafts WHERE id='d'").first()).body);
 assert.equal(d.status,'draft');assert.equal(d.version,2);assert.equal(d.approvalSource,undefined);
 assert.equal(await automatic(env,{action:'candidate'}),null);
});
test('two processors can reserve only one weekly attempt',async t=>{
 const {env,DB,s}=await fixture(t);
 const results=await Promise.allSettled([pub.prepare(env,'d',1,{since:s.autoPublishSince,userId:s.autoPublishUserId}),pub.prepare(env,'d',1,{since:s.autoPublishSince,userId:s.autoPublishUserId})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM publications').first()).n,1);
});
test('a large legacy approved backlog cannot hide new eligible drafts',async t=>{
 const {env,DB,d}=await fixture(t);
 await DB.batch(Array.from({length:100},(_,i)=>DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind('legacy'+i,JSON.stringify({...d,id:'legacy'+i,autoApprovedAt:undefined}))));
 assert.equal((await automatic(env,{action:'candidate'})).draft.id,'d');
});

test('weekly automatic cadence blocks candidate and atomic preparation after a recent manual post',async t=>{
 const {env,DB,s}=await fixture(t);
 await DB.prepare("INSERT INTO publications VALUES('recent','recent',1,'published','{}',?,0)").bind(Date.now()-2*86400000).run();
 assert.equal(await automatic(env,{action:'candidate'}),null);
 await assert.rejects(pub.prepare(env,'d',1,{since:s.autoPublishSince,userId:s.autoPublishUserId}),/publication_conflict/);
 await DB.prepare("UPDATE publications SET created=? WHERE id='recent'").bind(Date.now()-8*86400000).run();
 assert.equal((await automatic(env,{action:'candidate'})).draft.id,'d');
});
