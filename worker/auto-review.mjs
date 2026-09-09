// Scores are a conservative product threshold, not a probability of safety.
export function strictApproval(draft,evidence,mode) {
 if(mode!=='strict_auto'||!evidence||evidence.policy!=='strict-v1'||evidence.draftId!==draft.id)return false;
 if((draft.aspect??'4:5')!=='4:5'||draft.photos.some(p=>p.frame&&(p.frame.mode!=='fit'||p.frame.x!==50||p.frame.y!==50)))return false;
 const post=evidence.reviewedPost;
 if(!post||!['title','caption','hashtags'].every(k=>post[k]===draft[k])||!Array.isArray(post.photos)||post.photos.length!==draft.photos.length||!draft.photos.every((p,i)=>post.photos[i]?.id===p.id&&post.photos[i]?.alt===p.alt))return false;
 const ids=draft.photos.map(p=>p.id);
 if(JSON.stringify(evidence.photoIds)!==JSON.stringify(ids)||!Array.isArray(evidence.screens)||evidence.screens.length!==ids.length)return false;
 const screens=new Map(evidence.screens.filter(s=>s&&typeof s==='object').map(s=>[s.id,s]));
 if(screens.size!==ids.length||!ids.every(id=>{
  const s=screens.get(id);return s&&s.decision==='allow'&&s.landscape===true&&Array.isArray(s.flags)&&s.flags.length===0&&Number.isInteger(s.aesthetic)&&s.aesthetic>=9&&s.aesthetic<=10;
 }))return false;
 const r=evidence.review;
 return Boolean(r&&['privacySafe','captionGrounded','locationGrounded','coherent','compositionGood','noDuplicateFrames'].every(k=>r[k]===true)&&r.needsHumanReview===false);
}
