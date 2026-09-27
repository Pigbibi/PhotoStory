import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import {hash,put,seal} from '../worker/auth.mjs';

test('machine-only travel backfill verifies the original and stores only coarse metadata',async t=>{
 const {env,DB,api}=await setup(t);
 env.TOKEN_ENCRYPTION_KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
 await put(env,'microsoft',await seal(env,{access:'fixture-token',refresh:'unused',expires:Date.now()+3600000}));
 const item='item-1',drive='drive-1',etag='version-1',photoId=await hash(drive+':'+item);
 await put(env,'photo-source:'+photoId,{item,version:await hash(photoId+'\0'+etag)});
 const draft={id:'draft-1',status:'approved',version:1,photos:[{id:photoId,alt:'Landscape',frame:{mode:'crop',x:50,y:50}}]};
 await DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind(draft.id,JSON.stringify(draft)).run();
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.match(String(url),/graph\.microsoft\.com\/v1\.0\/me\/drive\/items\/item-1/);
  assert.equal(options.redirect,'manual');
  return Response.json({id:item,parentReference:{driveId:drive},eTag:etag,
   photo:{takenDateTime:'2025-01-10T12:00:00Z'},location:{latitude:13.756,longitude:100.501}});
 });
 assert.equal((await api('/internal/travel-backfill',{cursor:null})).status,401);
 const result=await(await api('/internal/travel-backfill',{cursor:null},true)).json();
 assert.deepEqual(result,{updated:1,skipped:0,next:'draft-1',done:true});
 const saved=JSON.parse((await DB.prepare("SELECT body FROM drafts WHERE id='draft-1'").first()).body);
 assert.deepEqual(saved.travel,{day:Math.floor(Date.parse('2025-01-10T12:00:00Z')/86400000),area:[13.8,100.5]});
 assert.equal(saved.version,1);
 assert.deepEqual(await(await api('/internal/travel-backfill',{cursor:null},true)).json(),{updated:0,skipped:0,next:null,done:true});
});

test('changed OneDrive source is skipped without changing approved copy',async t=>{
 const {env,DB,api}=await setup(t);
 env.TOKEN_ENCRYPTION_KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
 await put(env,'microsoft',await seal(env,{access:'fixture-token',refresh:'unused',expires:Date.now()+3600000}));
 const item='item-1',photoId=await hash('drive-1:'+item);
 await put(env,'photo-source:'+photoId,{item,version:await hash(photoId+'\0old-version')});
 const draft={id:'draft-1',status:'approved',version:1,caption:'Existing copy',photos:[{id:photoId}]};
 await DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind(draft.id,JSON.stringify(draft)).run();
 t.mock.method(globalThis,'fetch',async()=>Response.json({id:item,parentReference:{driveId:'drive-1'},eTag:'new-version',photo:{takenDateTime:'2025-01-10T12:00:00Z'}}));
 assert.deepEqual(await(await api('/internal/travel-backfill',{cursor:null},true)).json(),{updated:0,skipped:1,next:'draft-1',done:true});
 assert.deepEqual(JSON.parse((await DB.prepare("SELECT body FROM drafts WHERE id='draft-1'").first()).body),draft);
});
