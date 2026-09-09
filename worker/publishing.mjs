import {reviewedDraft} from './originals.mjs';
import {publishingAccount,publishingRequest} from './instagram.mjs';
import {ASPECTS,aspectValue} from './framing.mjs';
export const MAX_PUBLISH_IMAGE=1800000;
const HOUR=3600000;
const fail=code=>{throw new Error(code);};
export function jpegDimensions(data){
 if(data.length<20||data.length>MAX_PUBLISH_IMAGE||data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)fail('invalid_publish_image');
 let offset=2,size;
 while(offset+4<=data.length){
  if(data[offset++]!==255)fail('invalid_publish_image');
  const marker=data[offset++],length=data[offset]*256+data[offset+1];
  if(length<2||offset+length>data.length)fail('invalid_publish_image');
  // Canvas may emit an ICC color profile; reject EXIF/XMP and comments.
  if(marker===226){
   if(length<16||new TextDecoder().decode(data.slice(offset+2,offset+14))!=='ICC_PROFILE\0')fail('invalid_publish_image');
  }else if(marker>=225&&marker<=239||marker===254)fail('invalid_publish_image');
  if(marker===192||marker===194){
   if(size||length<17||data[offset+2]!==8||data[offset+7]!==3)fail('invalid_publish_image');
   size={height:data[offset+3]*256+data[offset+4],width:data[offset+5]*256+data[offset+6]};
  }
  if(marker===218){if(!size)fail('invalid_publish_image');return size;}
  offset+=length;
 }
 fail('invalid_publish_image');
}
const row=(e,id)=>e.DB.prepare('SELECT * FROM publications WHERE draft_id=?').bind(id).first();
function publicState(p){
 if(!p)return null;const b=JSON.parse(p.body);
 return {id:p.id,version:p.version,status:p.status==='working'&&Date.now()-b.touched>120000?'uncertain':p.status,username:b.username,expires:p.expires,completed:b.children.length,total:b.photos.length,mediaId:b.mediaId||null,retryAfterMs:Math.max(0,(b.nextCheck||0)-Date.now())};
}
export async function view(e,id){return publicState(await row(e,id));}
export async function prepare(e,id,version){
 const draft=await reviewedDraft(e,id,version),account=await publishingAccount(e),existing=await row(e,id),now=Date.now();
 if(existing){
  if(existing.status!=='prepared')fail('publication_conflict');
  if(existing.version===version&&existing.expires>now+600000)return publicState(existing);
 }
 const publicationId=crypto.randomUUID(),body={username:account.username,userId:account.userId,origin:account.origin,photos:draft.photos.map(p=>({id:p.id,alt:p.alt})),caption:draft.caption+'\n\n'+draft.hashtags,children:[],waiting:null,parent:null,ready:false,touched:now};
 const result=await e.DB.prepare("INSERT INTO publications VALUES(?,?,?,'prepared',?,?,?) ON CONFLICT(draft_id) DO UPDATE SET id=excluded.id,version=excluded.version,status=excluded.status,body=excluded.body,created=excluded.created,expires=excluded.expires WHERE publications.status='prepared'")
  .bind(id,publicationId,version,JSON.stringify(body),now,now+HOUR).run();
 if(result.meta.changes!==1)fail('publication_conflict');
 await cleanup(e);return view(e,id);
}
export async function upload(e,id,publicationId,photoId,data){
 const p=await row(e,id);if(!p||p.id!==publicationId||p.status!=='prepared'||p.expires<=Date.now())fail('publication_conflict');
 const draft=await reviewedDraft(e,id,p.version);if(!draft.photos.some(x=>x.id===photoId))fail('invalid_publish_image');
 const dimensions=jpegDimensions(data);
 if(dimensions.width!==1080||dimensions.height!==Math.round(1080/ASPECTS[aspectValue(draft.aspect)]))fail('invalid_publish_image');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
 await e.DB.prepare("INSERT OR IGNORE INTO publication_images SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM publications WHERE id=? AND status='prepared' AND expires>?)")
  .bind(publicationId,photoId,data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),digest,publicationId,Date.now()).run();
 const saved=await e.DB.prepare('SELECT digest FROM publication_images WHERE publication_id=? AND photo_id=?').bind(publicationId,photoId).first();
 if(saved?.digest!==digest)fail('publication_conflict');
 return {ok:true};
}
export async function begin(e,id,publicationId,version,username){
 const draft=await reviewedDraft(e,id,version),account=await publishingAccount(e),p=await row(e,id);
 if(!p||p.id!==publicationId||p.version!==version||p.status!=='prepared'||p.expires<=Date.now())fail('publication_conflict');
 const b=JSON.parse(p.body);
 if(username!==account.username||b.username!==account.username||b.userId!==account.userId||b.origin!==account.origin)fail('instagram_not_connected');
 const images=(await e.DB.prepare('SELECT photo_id FROM publication_images WHERE publication_id=?').bind(p.id).all()).results;
 if(images.length!==draft.photos.length||draft.photos.some(x=>!images.some(i=>i.photo_id===x.id)))fail('publication_incomplete');
 const result=await e.DB.prepare("UPDATE publications SET status='publishing',expires=? WHERE id=? AND status='prepared' AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND version=? AND json_extract(body,'$.status')='approved')")
  .bind(Date.now()+HOUR,p.id,id,version).run();
 if(result.meta.changes!==1)fail('publication_conflict');return view(e,id);
}
export async function media(e,publicationId,photoId){
 const r=await e.DB.prepare("SELECT i.data FROM publication_images i JOIN publications p ON p.id=i.publication_id WHERE p.id=? AND i.photo_id=? AND p.status IN ('publishing','working','published') AND p.expires>?").bind(publicationId,photoId,Date.now()).first();
 return r?new Response(new Uint8Array(r.data),{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}}):new Response('Not found',{status:404});
}
export async function privateImage(e,id,publicationId,photoId){
 const p=await row(e,id);if(!p||p.id!==publicationId||p.expires<=Date.now())return new Response('Not found',{status:404});
 const r=await e.DB.prepare('SELECT data FROM publication_images WHERE publication_id=? AND photo_id=?').bind(publicationId,photoId).first();
 return r?new Response(new Uint8Array(r.data),{headers:{'Content-Type':'image/jpeg'}}):new Response('Not found',{status:404});
}
export async function advance(e,id,publicationId){
 const p=await row(e,id);if(!p||p.id!==publicationId)fail('publication_conflict');
 if(p.status!=='publishing')return publicState(p);
 const b=JSON.parse(p.body);if((b.nextCheck||0)>Date.now())return publicState(p);b.touched=Date.now();
 const claimed=await e.DB.prepare("UPDATE publications SET status='working',body=? WHERE id=? AND status='publishing' AND body=?").bind(JSON.stringify(b),p.id,p.body).run();
 if(claimed.meta.changes!==1)return view(e,id);
 let status='publishing';
 try{
  if(p.expires<=Date.now())fail('publication_failed');
  await reviewedDraft(e,id,p.version);
  const account=await publishingAccount(e);
  if(account.username!==b.username||account.userId!==b.userId||account.origin!==b.origin)fail('instagram_not_connected');
  const call=(path,body)=>publishingRequest(account,path,body);
  const validId=result=>{if(typeof result?.id!=='string'||!/^\d{1,32}$/.test(result.id))fail('publication_failed');return result.id;};
  if(b.waiting){
   const result=await call(b.waiting);
   if(result.status_code==='FINISHED'){b.waiting=null;b.nextCheck=0;b.polls=0;if(b.parent)b.ready=true;}
   else if(result.status_code==='IN_PROGRESS'){b.polls=(b.polls||0)+1;if(b.polls>=5)fail('publication_failed');b.nextCheck=Date.now()+60000;}
   else fail('publication_failed');
  }else if(b.children.length<b.photos.length){
   const photo=b.photos[b.children.length],single=b.photos.length===1;
   const container=validId(await call(b.userId+'/media',{image_url:b.origin+'/delivery/'+p.id+'/'+photo.id,alt_text:photo.alt,...(single?{caption:b.caption}:{is_carousel_item:'true'})}));
   b.children.push(container);b.waiting=container;if(single)b.parent=container;
  }else if(!b.parent){
   b.parent=validId(await call(b.userId+'/media',{media_type:'CAROUSEL',children:b.children.join(','),caption:b.caption}));b.waiting=b.parent;
  }else if(b.ready){
   b.mediaId=validId(await call(b.userId+'/media_publish',{creation_id:b.parent}));status='published';b.publishedAt=Date.now();
  }else fail('publication_failed');
 }catch{status='uncertain';}
 // Never release a lost/ambiguous claim to be retried. A crashed call stays working.
 await e.DB.prepare("UPDATE publications SET status=?,body=? WHERE id=? AND status='working'").bind(status,JSON.stringify(b),p.id).run();
 return view(e,id);
}
export async function cleanup(e,now=Date.now()){
 await e.DB.prepare('DELETE FROM publication_images WHERE NOT EXISTS(SELECT 1 FROM publications WHERE publications.id=publication_images.publication_id AND publications.expires>?)').bind(now).run();
}
