import test from "node:test";
import assert from "node:assert/strict";
import { validateDraft, reviewDraft } from "../worker/review.mjs";
import {setup} from './helpers/database.mjs';
import worker from '../worker/index.mjs';
import {seal} from '../worker/auth.mjs';
const draft = () => ({
  id: "trip-1",
  title: "海岸",
  caption: "A quiet coast.",
  hashtags: "#Thailand",
  photos: [{ id: "p1", alt: "Coast" }],
  status: "draft",
  version: 1,
});
test("approval is bound to the reviewed version", () => {
  assert.equal(
    reviewDraft(draft(), { ...draft(), action: "approve" }).status,
    "approved",
  );
  assert.throws(
    () => reviewDraft(draft(), { ...draft(), version: 0, action: "approve" }),
    /conflict/,
  );
});
test("owner approval metadata is added only by the automation route", () => {
 const approved=reviewDraft({...draft(),status:"approved",approvalSource:"strict_ai_v1",strictReviewSoftFields:{coherent:true,compositionGood:true,noDuplicateFrames:true}}, {...draft(),status:"approved",approvalSource:"strict_ai_v1",strictReviewSoftFields:{coherent:true,compositionGood:true,noDuplicateFrames:true},action:"approve"});
 assert.equal(approved.approvalSource,undefined);
 assert.equal(approved.ownerApprovedAt,undefined);
});
test("editing an approved draft invalidates approval", () => {
  assert.equal(
    reviewDraft(
      { ...draft(), status: "approved" },
      { ...draft(), action: "save", caption: "Changed." },
    ).status,
    "draft",
  );
});
test('duplicate warning follows the same photos while edited copy loses its AI verdict',()=>{
 const current={...draft(),crossReview:{status:'checked',duplicateIds:['older'],captionGrounded:false,locationGrounded:false}};
 const saved=reviewDraft(current,{...current,action:'save',caption:'A corrected coast.'});
 assert.deepEqual(saved.crossReview,{status:'checked',duplicateIds:['older'],captionGrounded:null,locationGrounded:null});
});
test("cannot publish through review actions", () => {
  assert.throws(
    () => reviewDraft(draft(), { ...draft(), action: "publish" }),
    /invalid_action/,
  );
});
test("cannot inject a new photo during review", () => {
  assert.throws(
    () =>
      reviewDraft(draft(), {
        ...draft(),
        action: "save",
        photos: [{ id: "unknown", alt: "Coast" }],
      }),
    /unknown_photo/,
  );
});
test("duplicate photos and empty captions are rejected", () => {
  assert.throws(() => validateDraft({ ...draft(), caption: "" }), /caption/);
  assert.throws(
    () =>
      validateDraft({
        ...draft(),
        photos: [...draft().photos, ...draft().photos],
      }),
    /duplicate/,
  );
});
test("untrusted generated status is reset on import", () => {
  assert.equal(
    validateDraft({ ...draft(), status: "published" }).status,
    "draft",
  );
});
test('private travel hint survives copy edits and cannot be changed by an owner form',()=>{
 const current={...draft(),travel:{day:20000,area:[13.7,100.5]}};
 const saved=reviewDraft(current,{...current,action:'save',caption:'A different coast.',travel:{day:20000,area:[22.3,114.2]}});
 assert.deepEqual(saved.travel,current.travel);
 assert.throws(()=>validateDraft({...draft(),travel:{day:20000,area:[91,100.5]}}),/invalid_travel/);
});
test("removing all photos is rejected", () => {
  assert.throws(
    () => reviewDraft(draft(), { ...draft(), action: "save", photos: [] }),
    /photos/,
  );
});
test("image URLs and HTML are never interpreted by the model validator", () => {
  const d = validateDraft({
    ...draft(),
    photos: [{ id: "p1", alt: "<script>", url: "https://evil.invalid" }],
  });
  assert.equal(d.photos[0].url, undefined);
});
test('rejection feedback is validated and stored once for later curation',async t=>{
 const {DB,env,api}=await setup(t);
 env.TOKEN_ENCRYPTION_KEY=btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
 await DB.prepare("UPDATE state SET value=? WHERE key='microsoft'").bind(JSON.stringify(await seal(env,{access:'fixture-token',expires:Date.now()+3600000}))).run();
 await DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind('trip-1',JSON.stringify(draft())).run();
 const send=body=>worker.fetch(new Request('https://example.test/api/drafts/trip-1',{method:'PATCH',headers:{Cookie:'__Host-photostory=session',Origin:'https://example.test'},body:JSON.stringify(body)}),env);
 assert.equal((await send({...draft(),action:'trash',feedback:{category:'unknown',note:'no'}})).status,400);
 const response=await send({...draft(),action:'trash',feedback:{category:'weak_cover',note:'  The second frame is stronger.  '}});
 assert.equal(response.status,200);
 const saved=await response.json();
 assert.deepEqual(saved.ownerFeedback,{category:'weak_cover',note:'The second frame is stronger.'});
 const feedback=JSON.parse((await DB.prepare("SELECT value FROM state WHERE key='ownerRejectionFeedback'").first()).value);
 assert.deepEqual(feedback,{categories:{weak_cover:1},recent:[{category:'weak_cover',note:'The second frame is stronger.'}]});
 assert.equal((await send({...draft(),action:'trash'})).status,409);
 assert.deepEqual(JSON.parse((await DB.prepare("SELECT value FROM state WHERE key='ownerRejectionFeedback'").first()).value),feedback);
 await DB.prepare('INSERT INTO drafts VALUES(?,?,1)').bind('prior',JSON.stringify({...draft(),id:'prior',status:'approved'})).run();
 await api('/api/jobs',{folder:'Photos',range:'all'});
 const claim=await(await api('/internal/claim',{},true)).json();
 const sourceResponse=await api('/internal/source',{jobId:claim.id,lease:claim.lease},true);
 assert.equal(sourceResponse.status,200);
 const source=await sourceResponse.json();
 assert.deepEqual(source.ownerRejectionFeedback,feedback);
 assert.deepEqual(source.referenceDrafts,[{id:'prior',status:'approved',title:'海岸',caption:'A quiet coast.',photos:[{alt:'Coast'}]}]);
});
