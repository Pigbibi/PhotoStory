import test from 'node:test';
import assert from 'node:assert/strict';
import {localizedDraftText} from '../src/i18n-core.mjs';
import {validateDraft,reviewDraft} from '../worker/review.mjs';
const draft={id:'d',title:'海岸',reason:'海景',caption:'A coast.',hashtags:'#Coast',photos:[{id:'p',alt:'Coast'}],translations:{en:{title:'Coast',reason:'Sea views'},ja:{title:'海岸',reason:'海の景色'}}};
test('draft display uses UI language without changing approved content',()=>{
 const d={...validateDraft(draft),status:'approved'};
 assert.equal(localizedDraftText(d,'title','en'),'Coast');
 assert.equal(localizedDraftText(d,'reason','ja'),'海の景色');
 assert.equal(localizedDraftText(d,'title','fr'),'海岸');
 assert.equal(d.title,'海岸');assert.equal(d.status,'approved');
 const saved=reviewDraft(d,{...d,translations:undefined,action:'save'});
 assert.equal(saved.status,'approved');assert.deepEqual(saved.translations,d.translations);
});
test('editing title removes stale translations and invalidates approval',()=>{
 const d={...validateDraft(draft),status:'approved'};
 const changed=reviewDraft(d,{...d,title:'New title',action:'save'});
 assert.equal(changed.status,'draft');assert.equal(changed.translations,undefined);
 assert.equal(localizedDraftText(changed,'title','en'),'New title');
});
test('draft translations reject unknown locales and oversized text',()=>{
 assert.throws(()=>validateDraft({...draft,translations:{xx:{title:'X',reason:'Y'}}}),/translation/);
 assert.throws(()=>validateDraft({...draft,translations:{en:{title:'x'.repeat(161),reason:'Y'}}}),/title/);
});
