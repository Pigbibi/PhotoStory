import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import * as history from '../worker/history.mjs';
import worker from '../worker/index.mjs';
import {put,seal} from '../worker/auth.mjs';
test('publication ledger survives removed previews and deduplicates source ids',async t=>{
 const {DB,env}=await setup(t);
 for(const [id,status,photos] of [['a','published',[{id:'p1'},{id:'p2'}]],['b','published',[{id:'p1'}]],['c','uncertain',[{id:'p3'}]],['d','prepared',[{id:'p4'}]]]){
  await DB.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?,?)').bind(id,id,1,status,JSON.stringify({username:'owner',photos,mediaId:status==='published'?'123':null,touched:10,children:[]}),1,0).run();
 }
 const value=await history.summary(env);
 assert.equal(value.posts,2);assert.equal(value.photos,3);assert.equal(value.uniquePhotos,2);
 assert.deepEqual((await history.excluded(env)).sort(),['p1','p2','p3']);
 assert.equal((await worker.fetch(new Request('https://example.test/api/history'),env)).status,401);
 assert.ok(!JSON.stringify(value).includes('access_token'));
});
test('inventory reports metadata matches without claiming OneDrive source matches',async t=>{
 const {DB,env}=await setup(t);
 Object.assign(env,{INSTAGRAM_CLIENT_ID:'1234',INSTAGRAM_CLIENT_SECRET:'fixture',INSTAGRAM_USERNAME:'owner',INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',TOKEN_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))});
 await put(env,'instagram',await seal(env,{access:'private-token',client:'1234',userId:'456',username:'owner',permissions:['instagram_business_basic','instagram_business_content_publish'],expires:Date.now()+3600000}));
 await DB.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?,?)').bind('local','local',1,'published',JSON.stringify({mediaId:'ig-parent',children:['ig-child'],photos:[{id:'source-1'}]}),1,0).run();
 await put(env,'instagram-history:456',{records:[
  {id:'ig-parent',at:1,photos:1,photoIds:['ig-child']},
  {id:'foreign',at:2,photos:2,photoIds:['foreign-child']}
 ],after:null,checkedAt:3});
 const value=await history.summary(env);
 assert.equal(value.instagram.matchCoverage.matchedPosts,1);
 assert.equal(value.instagram.matchCoverage.matchedPhotos,1);
 assert.equal(value.instagram.matchCoverage.sourceMatches,0);
 assert.equal(value.instagram.matchCoverage.mode,'metadata_only');
});
test('visual history proposals stay pending until owner confirmation',async t=>{
 const {DB,env}=await setup(t);
 Object.assign(env,{INSTAGRAM_CLIENT_ID:'1234',INSTAGRAM_CLIENT_SECRET:'fixture',INSTAGRAM_USERNAME:'owner',INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',TOKEN_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))});
 await put(env,'instagram',await seal(env,{access:'private-token',client:'1234',userId:'456',username:'owner',permissions:['instagram_business_basic','instagram_business_content_publish'],expires:Date.now()+3600000}));
 let value=await history.ingestMatches(env,{algorithm:'dhash-v1',complete:true,proposals:[{instagramId:'100',photoId:'source-1',distance:4}]});
 assert.equal(value.proposalCount,1);assert.equal(value.confirmedCount,0);assert.deepEqual(await history.excluded(env),[]);
 value=await history.confirmMatches(env,{matches:[{instagramId:'100',photoId:'source-1'}]});
 assert.equal(value.confirmedCount,1);assert.deepEqual(await history.excluded(env),['source-1']);
 await put(env,'instagram-history:456',{records:[{id:'100',at:1,photos:1,photoIds:['101']}],after:null,checkedAt:3});
 assert.equal((await history.summary(env)).instagram.matchCoverage.sourceMatches,1);
 const response=await worker.fetch(new Request('https://example.test/api/history/matches',{headers:{Cookie:'__Host-photostory=session',Origin:'https://example.test'}}),env);
 assert.equal(response.status,200);assert.equal((await response.json()).confirmedCount,1);
});
import {mediaHistoryPage,mediaHistoryMediaPage} from '../worker/instagram.mjs';
async function account(t){
 const v=await setup(t);Object.assign(v.env,{INSTAGRAM_CLIENT_ID:'1234',INSTAGRAM_CLIENT_SECRET:'fixture',INSTAGRAM_USERNAME:'landscapes',INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',TOKEN_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))});
 await put(v.env,'instagram',await seal(v.env,{access:'private-token',client:'1234',userId:'456',username:'landscapes',permissions:['instagram_business_basic','instagram_business_content_publish'],expires:Date.now()+3600000}));return v;
}
test('Instagram inventory follows cursors on its fixed host and counts every carousel photo',async t=>{
 const {env}=await account(t);let calls=0;
 t.mock.method(globalThis,'fetch',async(url,o)=>{
  calls++;assert.equal(new URL(url).hostname,'graph.instagram.com');assert.equal(o.redirect,'manual');assert.equal(o.headers.Authorization,'Bearer private-token');assert.ok(!String(url).includes('private-token'));
  if(calls===1)return Response.json({data:[{id:'100',timestamp:'2025-05-01T00:00:00Z',media_type:'CAROUSEL_ALBUM',children:{data:[{id:'101',media_type:'IMAGE'},{id:'102',media_type:'IMAGE'}]}}],paging:{next:'https://evil.invalid/token',cursors:{after:'next-page'}}});
  assert.equal(new URL(url).searchParams.get('after'),'next-page');return Response.json({data:[{id:'200',timestamp:'2025-04-01T00:00:00Z',media_type:'IMAGE'}]});
 });
 let v=await history.sync(env);assert.deepEqual([v.instagram.posts,v.instagram.photos,v.instagram.complete],[1,2,false]);
 v=await history.sync(env);assert.deepEqual([v.instagram.posts,v.instagram.photos,v.instagram.complete],[2,3,true]);assert.equal(v.historyCoverage,'photostory_only');
 assert.ok(!JSON.stringify(v).includes('next-page'));assert.ok(!JSON.stringify(v).includes('private-token'));
});
test('a partial carousel cannot be recorded as complete',async t=>{
 const {env}=await account(t);t.mock.method(globalThis,'fetch',async()=>Response.json({data:[{id:'100',timestamp:'2025-05-01T00:00:00Z',media_type:'CAROUSEL_ALBUM',children:{data:[{id:'101',media_type:'IMAGE'}],paging:{next:'more'}}}]}));
 await assert.rejects(mediaHistoryPage(env),/instagram_connection_failed/);
});
test('history media URLs are bounded, fixed-host and never persisted',async t=>{
 const {env}=await account(t);
 await put(env,'instagram-history:456',{records:[{id:'100',at:1,photos:2,photoIds:['101','102']}],after:null,checkedAt:3});
 t.mock.method(globalThis,'fetch',async(url,o)=>{assert.equal(new URL(url).hostname,'graph.instagram.com');assert.equal(o.headers.Authorization,'Bearer private-token');return Response.json({id:'100',media_type:'CAROUSEL_ALBUM',children:{data:[{id:'101',media_type:'IMAGE',media_url:'https://scontent.cdninstagram.com/a.jpg'},{id:'102',media_type:'IMAGE',media_url:'https://scontent.cdninstagram.com/b.jpg'}]}});});
 const value=await mediaHistoryMediaPage(env);assert.equal(value.items.length,2);assert.equal(value.after,null);
 const state=await (await import('../worker/auth.mjs')).get(env,'instagram-history:456');assert.equal(JSON.stringify(state).includes('cdninstagram'),false);
});
