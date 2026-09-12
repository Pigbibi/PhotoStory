import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import * as ig from '../worker/instagram.mjs';
import {put,get,seal,unseal} from '../worker/auth.mjs';
const DAY=86400000;
async function fixture(t,patch={}){
 const f=await setup(t),now=Date.now();
 Object.assign(f.env,{INSTAGRAM_CLIENT_ID:'1234',INSTAGRAM_CLIENT_SECRET:'fixture-secret',INSTAGRAM_USERNAME:'landscapes',INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',TOKEN_ENCRYPTION_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))});
 const token={access:'old-fixture',client:'1234',username:'landscapes',userId:'456',permissions:['instagram_business_basic','instagram_business_content_publish'],expires:now+10*DAY,issuedAt:now-50*DAY,...patch};
 await put(f.env,'instagram',await seal(f.env,token));return {...f,now,token};
}
const saved=async e=>unseal(e,await get(e,'instagram'));
test('maintenance renews near-expiry credentials once and stores only ciphertext',async t=>{
 const {env,api,DB,now}=await fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls++;const u=new URL(url);assert.equal(u.origin,'https://graph.instagram.com');assert.equal(u.pathname,'/refresh_access_token');assert.equal(u.searchParams.get('grant_type'),'ig_refresh_token');assert.equal(u.searchParams.get('access_token'),'old-fixture');assert.equal(options.redirect,'manual');
  return Response.json({access_token:'new-fixture',token_type:'bearer',expires_in:5184000});
 });
 assert.equal((await api('/internal/maintenance',{},true)).status,200);
 assert.equal(calls,1);const value=await saved(env);assert.equal(value.access,'new-fixture');assert.ok(value.expires>=now+60*DAY);assert.equal(value.userId,'456');
 await ig.refresh(env,now+DAY);assert.equal(calls,1);
 assert.ok(!(await DB.prepare("SELECT value FROM state WHERE key='instagram'").first()).value.includes('new-fixture'));
 const status=await ig.status(env);assert.equal(status.autoRefresh,true);assert.ok(status.lastRenewedAt>=now);assert.ok(!JSON.stringify(status).includes('fixture'));
 assert.equal((await DB.prepare('SELECT count(*) AS n FROM publications').first()).n,0);
});
test('fresh, too-young, expired and mismatched connections are never refreshed',async t=>{
 for(const patch of [{expires:Date.now()+50*DAY},{issuedAt:Date.now()-DAY/2},{expires:Date.now()-1},{username:'someone_else'}])await t.test('ineligible',async t=>{
  const {env,now}=await fixture(t,patch);t.mock.method(globalThis,'fetch',()=>assert.fail('must not request'));await ig.refresh(env,now);
 });
});
test('concurrent maintenance claims only one refresh',async t=>{
 const {env,now}=await fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({access_token:'new-fixture',token_type:'bearer',expires_in:5184000});});
 await Promise.all([ig.refresh(env,now),ig.refresh(env,now)]);assert.equal(calls,1);
});
test('failed refresh preserves credentials, hides errors and backs off for one day',async t=>{
 const {env,now}=await fixture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('private provider detail',{status:400});});
 await ig.refresh(env,now);await ig.refresh(env,now+DAY-1);assert.equal(calls,1);assert.equal((await saved(env)).access,'old-fixture');
 const status=await ig.status(env);assert.equal(status.refreshState,'failed');assert.ok(!JSON.stringify(status).includes('private'));
 await ig.refresh(env,now+DAY);assert.equal(calls,2);
});
test('reconnection during refresh cannot be overwritten',async t=>{
 const {env,now,token}=await fixture(t);
 t.mock.method(globalThis,'fetch',async()=>{await put(env,'instagram',await seal(env,{...token,access:'reconnected-fixture'}));return Response.json({access_token:'stale-fixture',token_type:'bearer',expires_in:5184000});});
 await ig.refresh(env,now);assert.equal((await saved(env)).access,'reconnected-fixture');
});
test('redirects, malformed responses and shortened lifetimes cannot replace a token',async t=>{
 for(const value of [()=>new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/'}}),()=>Response.json({access_token:'bad',token_type:'bearer',expires_in:10}),()=>Response.json({access_token:'bad',expires_in:5184000})])await t.test('invalid response',async t=>{
  const {env,now}=await fixture(t);let calls=0;t.mock.method(globalThis,'fetch',async(_u,o)=>{calls++;assert.equal(o.redirect,'manual');return value();});
  await ig.refresh(env,now);assert.equal(calls,1);assert.equal((await saved(env)).access,'old-fixture');
 });
});
test('existing connections without issuance timestamps renew inside the due window',async t=>{
 const {env,now}=await fixture(t,{issuedAt:undefined});let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({access_token:'legacy-renewed-fixture',token_type:'bearer',expires_in:5184000});});
 await ig.refresh(env,now);assert.equal(calls,1);assert.equal((await saved(env)).refreshedAt,now);
});
