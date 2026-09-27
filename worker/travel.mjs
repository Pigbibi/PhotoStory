import {get,hash,microsoftToken} from './auth.mjs';
import {sourceRecord} from './originals.mjs';

function hint(metadata){
 const taken=Date.parse(metadata?.photo?.takenDateTime);
 if(!Number.isFinite(taken))return null;
 const {latitude:lat,longitude:lon}=metadata.location||{};
 const area=typeof lat==='number'&&typeof lon==='number'&&Number.isFinite(lat)&&Number.isFinite(lon)&&
   Math.abs(lat)<=90&&Math.abs(lon)<=180?[Math.round(lat*10)/10,Math.round(lon*10)/10]:null;
 return {day:Math.floor(taken/86400000),area};
}

// A bounded, machine-only migration for drafts created before travel hints
// existed. No image bytes or precise coordinates are returned or stored.
export async function backfillTravel(e,cursor=null){
 if(cursor!==null&&(typeof cursor!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(cursor)))throw new Error('invalid_request');
 const rows=(await e.DB.prepare("SELECT id,body,version FROM drafts WHERE id>? AND json_extract(body,'$.status')='approved' AND json_type(body,'$.travel') IS NULL ORDER BY id LIMIT 5").bind(cursor||'').all()).results;
 if(!rows.length)return {updated:0,skipped:0,next:cursor,done:true};
 const token=await microsoftToken(e);
 let updated=0,skipped=0;
 for(const row of rows){
  try{
   const draft=JSON.parse(row.body),photoId=draft.photos?.[0]?.id;
   if(typeof photoId!=='string')throw new Error('source_unavailable');
   const source=sourceRecord(await get(e,'photo-source:'+photoId));
   const url='https://graph.microsoft.com/v1.0/me/drive/items/'+encodeURIComponent(source.item)+'?$select=id,parentReference,eTag,photo,location';
   const response=await fetch(url,{headers:{Authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(20000)});
   if(!response.ok||Number(response.headers.get('content-length'))>65536)throw new Error('source_metadata_unavailable');
   const raw=await response.text();
   if(raw.length>65536)throw new Error('source_metadata_unavailable');
   const meta=JSON.parse(raw);
   if(meta.id!==source.item||!meta.parentReference?.driveId||typeof meta.eTag!=='string'||
      await hash(meta.parentReference.driveId+':'+meta.id)!==photoId||
      await hash(photoId+'\0'+meta.eTag)!==source.version)throw new Error('source_changed');
   const travel=hint(meta);
   if(!travel)throw new Error('capture_time_unavailable');
   const result=await e.DB.prepare("UPDATE drafts SET body=json_set(body,'$.travel',json(?)) WHERE id=? AND body=? AND version=? AND json_extract(body,'$.status')='approved' AND json_type(body,'$.travel') IS NULL")
     .bind(JSON.stringify(travel),row.id,row.body,row.version).run();
   if(result.meta.changes===1)updated++;else skipped++;
  }catch{skipped++;}
 }
 return {updated,skipped,next:rows.at(-1).id,done:rows.length<5};
}
