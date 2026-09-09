import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDraft,validateDraft} from '../worker/review.mjs';
const draft=()=>validateDraft({id:'d1',title:'Coast',caption:'Coast.',photos:[{id:'p1',alt:'Coast'},{id:'p2',alt:'Hill'}]});
test('one aspect ratio per draft and per-photo framing survive review',()=>{
 const d=draft(); const saved=reviewDraft(d,{...d,action:'save',aspect:'4:5',photos:d.photos.map(p=>({...p,frame:{mode:'crop',x:20,y:80}}))});
 assert.equal(saved.aspect,'4:5'); assert.deepEqual(saved.photos[0].frame,{mode:'crop',x:20,y:80});
 const approved=reviewDraft(saved,{...saved,action:'approve'});
 assert.equal(approved.status,'approved');
 assert.equal(reviewDraft(approved,{...approved,action:'save',aspect:'1:1'}).status,'draft');
 assert.throws(()=>reviewDraft(approved,{...approved,action:'approve',photos:approved.photos.map(p=>({...p,frame:{mode:'fit',x:50,y:50}}))}),/save_before_approval/);
});
test('invalid framing rejected and legacy drafts remain reviewable',()=>{
 const d=draft(); delete d.aspect; for(const p of d.photos) delete p.frame;
 assert.equal(reviewDraft(d,{...d,action:'approve'}).status,'approved');
 for(const aspect of ['9:16',null,{},'url(evil)']) assert.throws(()=>validateDraft({...d,aspect}),/invalid_framing/);
 for(const frame of [null,{mode:'crop',x:NaN,y:50},{mode:'crop',x:101,y:50},{mode:'stretch',x:50,y:50}]) assert.throws(()=>validateDraft({...d,photos:[{id:'p1',alt:'Coast',frame}]}),/invalid_framing/);
});
