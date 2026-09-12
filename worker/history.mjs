import {get,put} from './auth.mjs';
import {mediaHistoryPage,publishingAccount} from './instagram.mjs';
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
function matchCoverage(records){
 const photos=records.reduce((n,p)=>n+p.photos,0);
 const matchedPosts=records.filter(p=>p.matchState==='photostory_post');
 const matchedPhotos=matchedPosts.reduce((n,p)=>n+p.photos,0);
 return {mode:'metadata_only',matchedPosts:matchedPosts.length,matchedPhotos,
  importedPosts:records.length,importedPhotos:photos,
  sourceMatches:0,sourceMatchCoverage:0,
  note:'instagram_media_ids_do_not_identify_onedrive_files'};
}
// Publication records outlive temporary images and externally deleted posts.
export async function excluded(e){
 const rows=await e.DB.prepare("SELECT DISTINCT json_extract(j.value,'$.id') AS id FROM publications p,json_each(p.body,'$.photos') j WHERE p.status IN ('published','publishing','working','uncertain')").all();
 return rows.results.map(x=>x.id).filter(x=>typeof x==='string');
}
export async function summary(e){
 const totals=await e.DB.prepare("SELECT count(*) AS posts,coalesce(sum(json_array_length(body,'$.photos')),0) AS photos FROM publications WHERE status='published'").first();
 const unique=await e.DB.prepare("SELECT count(DISTINCT json_extract(j.value,'$.id')) AS n FROM publications p,json_each(p.body,'$.photos') j WHERE p.status='published'").first();
 const rows=await e.DB.prepare("SELECT draft_id,body,created FROM publications WHERE status='published' ORDER BY created DESC LIMIT 100").all();
 let instagram=null;
 try{const a=await publishingAccount(e);const h=await get(e,'instagram-history:'+a.userId);if(h){const records=await annotateRecords(e,h.records);instagram={posts:records.length,photos:records.reduce((n,p)=>n+p.photos,0),complete:!h.after,checkedAt:h.checkedAt,matchCoverage:matchCoverage(records)};}}catch{}
 return {...totals,instagram,uniquePhotos:unique.n,historyCoverage:'photostory_only',records:rows.results.map(r=>{
  const b=JSON.parse(r.body);
  return {draftId:r.draft_id,username:b.username,at:b.touched||r.created,photos:b.photos.length,mediaId:b.mediaId};
 })};
}

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
