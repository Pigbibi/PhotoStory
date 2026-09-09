import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/database.mjs';
import {maintenance,defaults} from '../worker/lifecycle.mjs';
import {jobLanguages} from '../worker/languages.mjs';
test('new jobs freeze owner languages and ignore client language overrides',async t=>{
 const {api,env,DB}=await setup(t);env.AI_CAPTION_LANGUAGE='ja';env.AI_EDITOR_LANGUAGE='en';
 const r=await api('/api/jobs',{folder:'Photos',range:'1m',captionLanguage:'fr'});assert.equal(r.status,201);
 const body=JSON.parse((await DB.prepare('SELECT body FROM jobs').first()).body);
 assert.equal(body.captionLanguage,'ja');assert.equal(body.editorLanguage,'en');
 env.AI_CAPTION_LANGUAGE='de';assert.equal(JSON.parse((await DB.prepare('SELECT body FROM jobs').first()).body).captionLanguage,'ja');
});
test('language defaults are English and invalid vars fail closed before job creation',async t=>{
 assert.deepEqual(jobLanguages({}),{captionLanguage:'en',editorLanguage:'en'});
 const {api,env,DB}=await setup(t);env.AI_CAPTION_LANGUAGE='arbitrary instructions';
 const r=await api('/api/jobs',{folder:'Photos',range:'1m'});assert.equal(r.status,400);
 assert.equal((await r.json()).error,'invalid_language');assert.equal(await DB.prepare('SELECT id FROM jobs').first(),null);
});
test('scheduled jobs freeze the same configured languages',async t=>{
 const {env,DB}=await setup(t);env.AI_CAPTION_LANGUAGE='ar';env.AI_EDITOR_LANGUAGE='fr';
 const now=Date.now();
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('automation',JSON.stringify({...defaults,enabled:true,folder:'Photos',nextRun:now-1})).run();
 await maintenance(env,now);
 const body=JSON.parse((await DB.prepare('SELECT body FROM jobs').first()).body);
 assert.equal(body.captionLanguage,'ar');assert.equal(body.editorLanguage,'fr');
});
