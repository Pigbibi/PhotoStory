import test from 'node:test';
import assert from 'node:assert/strict';
import {strictApproval} from '../worker/auto-review.mjs';
import {setup} from './helpers/database.mjs';
import {reviewDraft} from '../worker/review.mjs';
import {defaults} from '../worker/lifecycle.mjs';
const draft={id:'d',title:'Coast',caption:'A coast.',hashtags:'#Coast',photos:[{id:'p',alt:'Coast'}]};
const evidence=()=>({reviewedPost:{title:draft.title,caption:draft.caption,hashtags:draft.hashtags,photos:draft.photos},policy:'strict-v1',draftId:'d',photoIds:['p'],screens:[{id:'p',decision:'allow',flags:[],landscape:true,aesthetic:9}],review:{privacySafe:true,captionGrounded:true,locationGrounded:true,coherent:true,compositionGood:true,noDuplicateFrames:true,needsHumanReview:false}});
test('strict automatic approval requires all evidence and explicit mode',()=>{
 assert.equal(strictApproval(draft,evidence(),'strict_auto'),true);
 for(const mode of ['manual',undefined,'auto'])assert.equal(strictApproval(draft,evidence(),mode),false);
 for(const key of Object.keys(evidence().review)){
  const e=evidence();delete e.review[key];assert.equal(strictApproval(draft,e,'strict_auto'),false,key);
 }
 for(const patch of [{aesthetic:8},{aesthetic:9.5},{flags:['people']},{landscape:false}]){
  const e=evidence();Object.assign(e.screens[0],patch);assert.equal(strictApproval(draft,e,'strict_auto'),false);
 }
 assert.equal(strictApproval({...draft,caption:'Invented story'},evidence(),'strict_auto'),false);
 assert.equal(strictApproval({...draft,aspect:'3:2'},evidence(),'strict_auto'),false);
 const e=evidence();e.photoIds=['other'];assert.equal(strictApproval(draft,e,'strict_auto'),false);
});
async function run(t,mode,disableAtCommit=false){
 const {env,DB,api}=await setup(t);
 await DB.prepare('INSERT INTO state VALUES(?,?,NULL)').bind('automation',JSON.stringify({...defaults,reviewMode:mode})).run();
 await api('/api/jobs',{folder:'Photos',range:'1m'});
 const job=await(await api('/internal/claim',{},true)).json();
 const d={...draft,id:job.id+'-batch-1'},e={...evidence(),draftId:d.id};
 if(disableAtCommit){const batch=DB.batch;DB.batch=async stmts=>{await DB.prepare("UPDATE state SET value=json_set(value,'$.reviewMode','manual') WHERE key='automation'").bind().run();return batch(stmts);};}
 const r=await api('/internal/complete',{jobId:job.id,lease:job.lease,batchId:'batch',more:false,progress:{phase:'complete',total:1,processed:1,batches:1},drafts:[d],photos:[{id:'p',safety:'allow',flags:[],jpeg:'/9j/'}],autoReviews:[e]},true);
 assert.equal(r.status,200);return JSON.parse((await DB.prepare('SELECT body FROM drafts').first()).body);
}
test('manual mode never auto-approves even with a positive AI result',async t=>assert.equal((await run(t,'manual')).status,'draft'));
test('strict mode records AI approval; disabling it at commit leaves a draft',async t=>{
 const d=await run(t,'strict_auto');assert.equal(d.status,'approved');assert.equal(d.approvalSource,'strict_ai_v1');
 const saved=reviewDraft(d,{...d,action:'save'});assert.equal(saved.approvalSource,'strict_ai_v1');
 const changed=reviewDraft(saved,{...saved,action:'save',caption:'New caption'});assert.equal(changed.status,'draft');assert.equal(changed.approvalSource,undefined);
});
test('switching back to manual wins over in-flight positive AI review',async t=>assert.equal((await run(t,'strict_auto',true)).status,'draft'));
test('cropped approval binds the exact ratio and every crop position',()=>{
 const d={...draft,aspect:'3:2',photos:[{...draft.photos[0],frame:{mode:'crop',x:50,y:20}}]};
 const e={...evidence(),policy:'strict-v2',reviewedPost:{title:d.title,caption:d.caption,hashtags:d.hashtags,aspect:d.aspect,photos:d.photos}};
 assert.equal(strictApproval(d,e,'strict_auto'),true);
 assert.equal(strictApproval({...d,aspect:'4:5'},e,'strict_auto'),false);
 assert.equal(strictApproval({...d,photos:[{...d.photos[0],frame:{mode:'crop',x:50,y:50}}]},e,'strict_auto'),false);
 assert.equal(strictApproval(d,{...e,policy:'strict-v1'},'strict_auto'),false);
});
