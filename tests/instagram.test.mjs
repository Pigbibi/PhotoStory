import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import {setup} from './helpers/database.mjs';
import {seal,unseal,hash} from '../worker/auth.mjs';
const scopes='instagram_business_basic,instagram_business_content_publish';
async function fixture(t){
 const v=await setup(t);Object.assign(v.env,{INSTAGRAM_CLIENT_ID:'1234',INSTAGRAM_CLIENT_SECRET:'fixture-secret',INSTAGRAM_USERNAME:'landscapes',INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',TOKEN_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),AUTH_LIMITER:{limit:async()=>({success:true})}});return v;
}
async function begin(env){
 const r=await worker.fetch(new Request('https://example.test/auth/instagram/start',{headers:{Cookie:'__Host-photostory=session'}}),env);
 assert.equal(r.status,302);const u=new URL(r.headers.get('location'));assert.equal(u.origin,'https://www.instagram.com');return {r,u,state:u.searchParams.get('state')};
}
function finish(env,state,session='session',extra='code=fixture-code'){
 return worker.fetch(new Request('https://example.test/auth/instagram/callback?state='+state+'&'+extra,{headers:{Cookie:'__Host-photostory='+session+'; __Host-ps-ig='+state}}),env);
}
function provider(t,{username='landscapes',permissions=scopes,type='MEDIA_CREATOR',id='123',fail=false}={}){
 const calls=[];t.mock.method(globalThis,'fetch',async(url,o)=>{
  const u=new URL(url);calls.push(u.pathname);assert.equal(o.redirect,'error');
  if(fail)return new Response('private provider detail',{status:400});
  if(u.hostname==='api.instagram.com'){
   assert.equal(o.method,'POST');assert.equal(o.body.get('client_secret'),'fixture-secret');assert.equal(o.body.get('redirect_uri'),'https://example.test/auth/instagram/callback');return Response.json({data:[{access_token:'short-fixture',user_id:'123',permissions}]});
  }
  if(u.pathname==='/access_token'){assert.equal(u.searchParams.get('grant_type'),'ig_exchange_token');return Response.json({access_token:'long-fixture',expires_in:5184000,token_type:'bearer'});}
  assert.equal(u.pathname,'/v26.0/me');assert.equal(u.searchParams.get('fields'),'id,user_id,username,account_type');return Response.json({id,user_id:'456',username,account_type:type});
 });return calls;
}
test('Instagram start requires owner login, complete configuration and abuse limiter',async t=>{
 const {env,DB}=await fixture(t);
 assert.equal((await worker.fetch(new Request('https://example.test/auth/instagram/start'),env)).status,401);
 delete env.INSTAGRAM_CLIENT_SECRET;
 const r=await worker.fetch(new Request('https://example.test/auth/instagram/start',{headers:{Cookie:'__Host-photostory=session'}}),env);assert.match(r.headers.get('location')||'',/instagram_not_configured/);
 env.INSTAGRAM_CLIENT_SECRET='fixture-secret';delete env.AUTH_LIMITER;
 assert.equal((await worker.fetch(new Request('https://example.test/auth/instagram/start',{headers:{Cookie:'__Host-photostory=session'}}),env)).status,503);
 assert.equal((await DB.prepare("SELECT key FROM state WHERE key LIKE 'ig-oauth:%'").all()).results.length,0);
});
test('Instagram start uses fixed callback and only the two intended permissions',async t=>{
 const {env,DB}=await fixture(t);const {u,r,state}=await begin(env);
 assert.equal(u.searchParams.get('scope'),scopes);assert.equal(u.searchParams.get('redirect_uri'),env.INSTAGRAM_REDIRECT_URI);assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
 const row=await DB.prepare('SELECT value,expires FROM state WHERE key=?').bind('ig-oauth:'+await hash(state)).first();assert.ok(row.expires>Date.now());assert.ok(row.expires<=Date.now()+600000);assert.equal(JSON.parse(row.value).session,await hash('session'));
});
test('Instagram callback stores only encrypted credentials and never publishes',async t=>{
 const {env,DB}=await fixture(t);const {state}=await begin(env);const calls=provider(t);
 const r=await finish(env,state);assert.equal(r.headers.get('location'),'/?instagram=connected');
 const row=await DB.prepare("SELECT value FROM state WHERE key='instagram'").first();assert.ok(!row.value.includes('long-fixture'));
 const token=await unseal(env,JSON.parse(row.value));assert.equal(token.access,'long-fixture');assert.equal(token.username,'landscapes');assert.equal(token.userId,'456');
 const status=await worker.fetch(new Request('https://example.test/api/session',{headers:{Cookie:'__Host-photostory=session'}}),env);const body=await status.json();assert.equal(body.instagram.connected,true);assert.equal(body.instagram.username,'landscapes');assert.equal(body.publishingEnabled,false);assert.ok(!JSON.stringify(body).includes('fixture'));
 assert.equal(calls.length,3);assert.equal((await finish(env,state)).status,400);assert.equal(calls.length,3);
});
test('wrong session, expired state and changed expected account cannot exchange a code',async t=>{
 const {env,DB}=await fixture(t);const {state}=await begin(env);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not fetch')});
 await DB.prepare('INSERT INTO state VALUES(?,?,?)').bind('session:'+await hash('second'),JSON.stringify({login:'Pigbibi'}),Date.now()+600000).run();
 assert.equal((await finish(env,state,'second')).status,400);assert.equal(calls,0);
 env.INSTAGRAM_USERNAME='different';assert.equal((await finish(env,state)).status,400);assert.equal(calls,0);
 env.INSTAGRAM_USERNAME='landscapes';const next=await begin(env);await DB.prepare('UPDATE state SET expires=0 WHERE key=?').bind('ig-oauth:'+await hash(next.state)).run();assert.equal((await finish(env,next.state)).status,400);assert.equal(calls,0);
});
test('Instagram rejects wrong account, missing publish permission and personal profiles without replacing a connection',async t=>{
 for(const options of [{username:'someone_else'},{permissions:'instagram_business_basic'},{type:'PERSONAL'},{id:'other'}, {fail:true}])await t.test(JSON.stringify(options),async t=>{
  const {env,DB}=await fixture(t);const old=JSON.stringify(await seal(env,{access:'preserved-fixture'}));await DB.prepare("INSERT INTO state VALUES('instagram',?,NULL)").bind(old).run();
  const {state}=await begin(env);provider(t,options);const r=await finish(env,state);assert.equal(r.headers.get('location'),'/?error=instagram_connection_failed');assert.equal((await DB.prepare("SELECT value FROM state WHERE key='instagram'").first()).value,old);assert.ok(!(await r.text()).includes('private'));
 });
});
test('cancelled Instagram consent consumes the state and hides provider error text',async t=>{
 const {env,DB}=await fixture(t);const {state}=await begin(env);const r=await finish(env,state,'session','error=access_denied&error_description=private');assert.equal(r.headers.get('location'),'/?error=instagram_connection_failed');assert.equal(await DB.prepare('SELECT value FROM state WHERE key=?').bind('ig-oauth:'+await hash(state)).first(),null);
});
test('logout during Instagram exchange prevents saving a connection',async t=>{
 const {env,DB}=await fixture(t);const {state}=await begin(env);provider(t);
 const mocked=globalThis.fetch;t.mock.method(globalThis,'fetch',async(...args)=>{
  const result=await mocked(...args);
  if(new URL(args[0]).pathname==='/v26.0/me')await DB.prepare('DELETE FROM state WHERE key=?').bind('session:'+await hash('session')).run();
  return result;
 });
 assert.equal((await finish(env,state)).headers.get('location'),'/?error=instagram_connection_failed');assert.equal(await DB.prepare("SELECT value FROM state WHERE key='instagram'").first(),null);
});
test('two concurrent Instagram callbacks exchange the one-time code only once',async t=>{
 const {env}=await fixture(t);const {state}=await begin(env);const calls=provider(t);
 const responses=await Promise.all([finish(env,state),finish(env,state)]);assert.deepEqual(responses.map(r=>r.status).sort(),[302,400]);assert.equal(calls.length,3);
});
test('Instagram failure diagnostics retain only bounded stage metadata and expire',async t=>{
 const {env,DB}=await fixture(t);const {state}=await begin(env);provider(t,{fail:true});
 await finish(env,state);
 const row=await DB.prepare("SELECT value,expires FROM state WHERE key='instagram-diagnostic'").first();
 assert.ok(row);assert.deepEqual(JSON.parse(row.value),{stage:'short_token_request',httpStatus:400});
 assert.ok(row.expires>Date.now()&&row.expires<=Date.now()+600000);
 assert.ok(!row.value.includes('private'));
});
