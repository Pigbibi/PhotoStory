import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import worker from '../worker/index.mjs';
import {put} from '../worker/auth.mjs';

test('machine health is protected and redacts private job data',async t=>{
 const {DB,env}=await setup(t);
 assert.equal((await worker.fetch(new Request('https://example.test/internal/health'),env)).status,401);
 await put(env,'automation',{enabled:true,publishMode:'manual',reviewMode:'manual',frequency:'weekly',nextRun:123,version:1,pendingLimit:20});
 await DB.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').bind('job-1','{"scheduled":true,"folder":"private/folder","progress":{"phase":"processing","total":4,"processed":2,"analyzed":1,"batches":1}}','pending',10,null).run();
 const response=await worker.fetch(new Request('https://example.test/internal/health',{headers:{Authorization:'Bearer machine'}}),env);
 assert.equal(response.status,200);
 const value=await response.json();
 assert.equal(value.ok,false);assert.ok(value.warnings.includes('job_active'));
 assert.equal(value.lastJob.id,'job-1');assert.equal(value.lastJob.progress.processed,2);
 assert.equal(JSON.stringify(value).includes('private/folder'),false);
 assert.equal(JSON.stringify(value).includes('access_token'),false);
});

test('health reports automatic publishing authorization attention without probing Instagram',async t=>{
 const {env}=await setup(t);
 await put(env,'automation',{enabled:true,publishMode:'automatic',reviewMode:'strict_auto',frequency:'weekly',nextRun:123,version:1,pendingLimit:20});
 const response=await worker.fetch(new Request('https://example.test/internal/health',{headers:{Authorization:'Bearer machine'}}),env);
 const value=await response.json();
 assert.equal(response.status,200);assert.ok(value.warnings.includes('instagram_authorization'));
 assert.equal(value.instagram.connected,false);assert.equal(value.publication,null);
});
