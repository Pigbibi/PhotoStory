import {get,hash,microsoftToken} from './auth.mjs';
export const MAX_ORIGINAL_BYTES=25*1024*1024;
export function sourceRecord(value){
 if(!value||typeof value.item!=='string'||!/^[A-Za-z0-9!_-]{1,200}$/.test(value.item)||typeof value.version!=='string'||!/^[a-f0-9]{64}$/.test(value.version))throw new Error('source_unavailable');
 return {item:value.item,version:value.version};
}
export function downloadHost(value){
 try{const u=new URL(value);return u.protocol==='https:'&&(!u.port||u.port==='443')&&!u.username&&!u.password&&(['.1drv.com','.onedrive.com','.sharepoint.com','.storage.live.com','.livefilestore.com'].some(s=>u.hostname.endsWith(s))||/^[a-z0-9]+-mediap\.svc\.ms$/.test(u.hostname));}catch{return false;}
}
async function bytes(response,limit){
 if(!response.ok||!response.body)throw new Error('source_unavailable');
 if(Number(response.headers.get('content-length'))>limit){await response.body.cancel();throw new Error('original_too_large');}
 const reader=response.body.getReader(),parts=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('original_too_large');parts.push(value);}}
 catch(e){await reader.cancel();throw e;}
 const result=new Uint8Array(size);let offset=0;for(const p of parts){result.set(p,offset);offset+=p.length;}return result;
}
export async function reviewedDraft(e,id,version){
 const row=await e.DB.prepare('SELECT body FROM drafts WHERE id=?').bind(id).first();
 if(!row)throw new Error('source_unavailable');
 const draft=JSON.parse(row.body);
 if(draft.version!==version)throw new Error('version_conflict');
 if(draft.status!=='approved')throw new Error('approval_required');
 return draft;
}
export async function original(e,draftId,photoId,version){
 const draft=await reviewedDraft(e,draftId,version);
 if(!draft.photos.some(p=>p.id===photoId))throw new Error('source_unavailable');
 const source=sourceRecord(await get(e,'photo-source:'+photoId));
 const token=await microsoftToken(e),endpoint='https://graph.microsoft.com/v1.0/me/drive/items/'+encodeURIComponent(source.item);
 const metadata=async()=>{
  const r=await fetch(endpoint,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
  const meta=JSON.parse(new TextDecoder().decode(await bytes(r,1024*1024)));
  if(meta.id!==source.item||!meta.parentReference?.driveId||typeof meta.eTag!=='string'||await hash(meta.parentReference.driveId+':'+meta.id)!==photoId||await hash(photoId+'\0'+meta.eTag)!==source.version)throw new Error('source_changed');
  if(!['image/jpeg','image/png'].includes(meta.file?.mimeType)||meta.video||meta.remoteItem)throw new Error('original_format');
  if(!Number.isSafeInteger(meta.size)||meta.size<1||meta.size>MAX_ORIGINAL_BYTES)throw new Error('original_too_large');
  if(!Number.isSafeInteger(meta.image?.width)||!Number.isSafeInteger(meta.image?.height)||meta.image.width<1||meta.image.height<1||meta.image.width*meta.image.height>50000000)throw new Error('original_too_large');
  return meta;
 };
 const before=await metadata();
 const url=before['@microsoft.graph.downloadUrl'];
 if(!downloadHost(url))throw new Error('source_unavailable');
 // The pre-authenticated URL is never exposed to the browser and never receives
 // the Graph bearer token. A second redirect is not followed.
 const data=await bytes(await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)}),MAX_ORIGINAL_BYTES);
 if(data.length!==before.size)throw new Error('source_changed');
 if(before.file.mimeType==='image/jpeg' ? !(data[0]===255&&data[1]===216&&data[2]===255) : !(data[0]===137&&data[1]===80&&data[2]===78&&data[3]===71))throw new Error('original_format');
 await metadata();await reviewedDraft(e,draftId,version);
 return new Response(data,{headers:{'Content-Type':before.file.mimeType,'Content-Disposition':'attachment; filename="original"'}});
}
export async function recoverSource(e,id,item,fingerprint,policy){
 sourceRecord({item,version:fingerprint});
 if(typeof policy!=='string'||!/^[a-f0-9]{64}$/.test(policy))throw new Error('source_unavailable');
 const token=await microsoftToken(e);
 const r=await fetch('https://graph.microsoft.com/v1.0/me/drive/items/'+encodeURIComponent(item)+'?$select=id,parentReference,eTag',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
 const meta=JSON.parse(new TextDecoder().decode(await bytes(r,1024*1024)));
 if(meta.id!==item||typeof meta.eTag!=='string'||!meta.parentReference?.driveId||await hash(meta.parentReference.driveId+':'+item)!==id)throw new Error('source_changed');
 const version=await hash(id+'\0'+meta.eTag);
 if(await hash(policy+version)!==fingerprint)throw new Error('source_changed');
 return {item,version};
}
