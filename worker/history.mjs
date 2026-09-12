import {get,put} from './auth.mjs';
import {mediaHistoryPage,publishingAccount} from './instagram.mjs';
const MATCH_ALGORITHM='dhash-v1';
const PHOTO_ID=/^[A-Za-z0-9_-]{1,128}$/;
const IG_ID=/^\d{1,32}$/;
const matchKey=(a)=>'instagram-history-matches:'+a.userId;
async function matchState(e,a){return await get(e,matchKey(a))||{algorithm:MATCH_ALGORITHM,proposals:[],confirmed:[],updatedAt:null,complete:false};}
function matchingView(state){const proposals=Array.isArray(state.proposals)?state.proposals:[],confirmed=Array.isArray(state.confirmed)?state.confirmed:[],confirmedSet=new Set(confirmed);
 return {algorithm:state.algorithm||MATCH_ALGORITHM,complete:Boolean(state.complete),updatedAt:state.updatedAt||null,
 proposals,confirmed,proposalCount:proposals.length,confirmedCount:confirmed.length,pendingCount:proposals.filter(p=>!confirmedSet.has(p.photoId)).length};}
// An Instagram media id can prove that a post was created by PhotoStory, but
// it cannot identify the original OneDrive file. Keep that distinction explicit
// so callers never mistake inventory coverage for source-photo coverage.
async function annotateRecords(e,records){
 const rows=await e.DB.prepare("SELECT body FROM publications WHERE status='published'").all();
 const ids=new Set();
 for(const row of rows.results){
  try{
   const b=JSON.parse(row.body);if(typeof b.mediaId==='string')ids.add(b.mediaId);
   if(Array.isArray(b.children))for(const id of b.children)if(typeof id==='string')ids.add(id);
  }catch{}
 }
 return records.map(p=>({
  ...p,
  matchState:ids.has(p.id)||(Array.isArray(p.photoIds)&&p.photoIds.some(id=>ids.has(id)))?'photostory_post':'unmatched'
 }));
}
function matchCoverage(records,matching={confirmedCount:0}){
 const photos=records.reduce((n,p)=>n+p.photos,0);
 const matchedPosts=records.filter(p=>p.matchState==='photostory_post');
 const matchedPhotos=matchedPosts.reduce((n,p)=>n+p.photos,0);
 return {mode:'metadata_only',matchedPosts:matchedPosts.length,matchedPhotos,
  importedPosts:records.length,importedPhotos:photos,
  sourceMatches:matching.confirmedCount||0,sourceMatchCoverage:photos?Math.min(1,(matching.confirmedCount||0)/photos):0,
  note:'instagram_media_ids_do_not_identify_onedrive_files'};
}
// Publication records outlive temporary images and externally deleted posts.
export async function excluded(e){
 const rows=await e.DB.prepare("SELECT DISTINCT json_extract(j.value,'$.id') AS id FROM publications p,json_each(p.body,'$.photos') j WHERE p.status IN ('published','publishing','working','uncertain')").all();
 const matchRows=await e.DB.prepare("SELECT value FROM state WHERE key LIKE 'instagram-history-matches:%'").all();let confirmed=[];
 for(const row of matchRows.results){try{const state=JSON.parse(row.value);if(Array.isArray(state.confirmed))confirmed.push(...state.confirmed);}catch{}}
 return [...new Set([...rows.results.map(x=>x.id).filter(x=>typeof x==='string'),...confirmed])];
}
export async function summary(e){
 const totals=await e.DB.prepare("SELECT count(*) AS posts,coalesce(sum(json_array_length(body,'$.photos')),0) AS photos FROM publications WHERE status='published'").first();
 const unique=await e.DB.prepare("SELECT count(DISTINCT json_extract(j.value,'$.id')) AS n FROM publications p,json_each(p.body,'$.photos') j WHERE p.status='published'").first();
 const rows=await e.DB.prepare("SELECT draft_id,body,created FROM publications WHERE status='published' ORDER BY created DESC LIMIT 100").all();
 let instagram=null,matching=null;
 try{const a=await publishingAccount(e);const h=await get(e,'instagram-history:'+a.userId);matching=matchingView(await matchState(e,a));if(h){const records=await annotateRecords(e,h.records);instagram={posts:records.length,photos:records.reduce((n,p)=>n+p.photos,0),complete:!h.after,checkedAt:h.checkedAt,matchCoverage:matchCoverage(records,matching),matching};}}catch{}
 return {...totals,instagram,uniquePhotos:unique.n,historyCoverage:'photostory_only',records:rows.results.map(r=>{
  const b=JSON.parse(r.body);
  return {draftId:r.draft_id,username:b.username,at:b.touched||r.created,photos:b.photos.length,mediaId:b.mediaId};
 })};
}

// The processor submits only bounded visual-match metadata. It never submits
// provider URLs or image bytes, and proposals do not affect exclusion until an
// owner confirms them through the browser.
export async function ingestMatches(e,body){
 const a=await publishingAccount(e),state=await matchState(e,a);
 if(!body||body.algorithm!==MATCH_ALGORITHM||!Array.isArray(body.proposals)||body.proposals.length>500)throw new Error('invalid_request');
 const existing=new Map(state.proposals.map(p=>[p.instagramId+'|'+p.photoId,p]));
 for(const p of body.proposals){
  if(!IG_ID.test(p?.instagramId||'')||!PHOTO_ID.test(p?.photoId||'')||typeof p.distance!=='number'||!Number.isFinite(p.distance)||p.distance<0||p.distance>64)throw new Error('invalid_request');
  existing.set(p.instagramId+'|'+p.photoId,{instagramId:p.instagramId,photoId:p.photoId,distance:p.distance,algorithm:MATCH_ALGORITHM});
 }
 const proposals=[...existing.values()].slice(0,500),confirmed=new Set(state.confirmed||[]);
 const next={algorithm:MATCH_ALGORITHM,proposals,confirmed:[...confirmed].filter(id=>proposals.some(p=>p.photoId===id)),updatedAt:Date.now(),complete:body.complete===true};
 await put(e,matchKey(a),next);return matchingView(next);
}
export async function confirmMatches(e,body){
 const a=await publishingAccount(e),state=await matchState(e,a);
 if(!body||!Array.isArray(body.matches)||body.matches.length>500)throw new Error('invalid_request');
 const known=new Set(state.proposals.map(p=>p.instagramId+'|'+p.photoId)),confirmed=new Set(state.confirmed||[]);
 for(const p of body.matches){if(!IG_ID.test(p?.instagramId||'')||!PHOTO_ID.test(p?.photoId||'')||!known.has(p.instagramId+'|'+p.photoId))throw new Error('invalid_request');confirmed.add(p.photoId);}
 const next={...state,confirmed:[...confirmed],updatedAt:Date.now()};await put(e,matchKey(a),next);return matchingView(next);
}
export async function matching(e){const a=await publishingAccount(e);return matchingView(await matchState(e,a));}

export async function sync(e){
 const account=await publishingAccount(e),key='instagram-history:'+account.userId;
 const previous=await get(e,key);
 const page=await mediaHistoryPage(e,previous?.after||null);
 if(page.userId!==account.userId)throw new Error('instagram_not_connected');
 const records=new Map((previous?.records||[]).map(p=>[p.id,p]));
 for(const p of page.records)records.set(p.id,p);
 if(records.size>10000)throw new Error('invalid_request');
 await put(e,key,{records:[...records.values()],after:page.after,checkedAt:Date.now()});
 return summary(e);
}
