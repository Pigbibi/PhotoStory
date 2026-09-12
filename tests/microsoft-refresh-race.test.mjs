import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import {put,get,seal,unseal,microsoftToken} from '../worker/auth.mjs';
test('an old OneDrive refresh cannot overwrite a newly connected account',async t=>{
 const {env}=await setup(t);
 env.TOKEN_ENCRYPTION_KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
 await put(env,'microsoft',await seal(env,{access:'old',refresh:'old-refresh',expires:0}));
 t.mock.method(globalThis,'fetch',async()=>{
  await put(env,'microsoft',await seal(env,{access:'new-account',refresh:'new-refresh',expires:Date.now()+3600000}));
  return Response.json({access_token:'old-account-refreshed',refresh_token:'old-rotated',expires_in:3600});
 });
 await microsoftToken(env).catch(()=>{});
 assert.equal((await unseal(env,await get(env,'microsoft'))).access,'new-account');
});
