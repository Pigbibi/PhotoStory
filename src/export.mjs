import {zipSync,strToU8} from 'fflate';
import {ASPECTS,photoFrame,aspectValue} from '../worker/framing.mjs';
export function placement(width,height,aspect,frame){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1||width*height>50000000)throw new Error('original_too_large');
 const w=1080,h=Math.round(w/ASPECTS[aspectValue(aspect)]),f=photoFrame(frame);
 const scale=f.mode==='fit'?Math.min(w/width,h/height):Math.max(w/width,h/height);
 if(scale>1)throw new Error('original_too_small');
 const dw=width*scale,dh=height*scale;
 return {width:w,height:h,x:(w-dw)*f.x/100,y:(h-dh)*f.y/100,drawWidth:dw,drawHeight:dh};
}
async function request(draft,photoId){
 const r=await fetch('/api/export/'+draft.id+(photoId?'/'+photoId:''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:draft.version})});
 if(!r.ok)throw new Error('export_failed');return r;
}
export async function exportDraft(draft,onProgress){
 const approved=await(await request(draft)).json();
 const files=Object.create(null);
 for(let i=0;i<approved.photos.length;i++){
  const photo=approved.photos[i],blob=await(await request(approved,photo.id)).blob();
  // Browser decoding respects the original orientation. Re-encoding via canvas
  // strips source EXIF/GPS metadata. Only one original is decoded at a time.
  const image=await createImageBitmap(blob,{imageOrientation:'from-image'});
  let canvas;
  try{
   const p=placement(image.width,image.height,approved.aspect,photo.frame);
   canvas=document.createElement('canvas');canvas.width=p.width;canvas.height=p.height;
   const ctx=canvas.getContext('2d');if(!ctx)throw new Error('export_failed');
   ctx.fillStyle='#fff';ctx.fillRect(0,0,p.width,p.height);ctx.drawImage(image,p.x,p.y,p.drawWidth,p.drawHeight);
   const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.95));if(!jpeg)throw new Error('export_failed');
   files[String(i+1).padStart(2,'0')+'.jpg']=new Uint8Array(await jpeg.arrayBuffer());
  }finally{image.close();if(canvas){canvas.width=1;canvas.height=1;}}
  onProgress?.(i+1,approved.photos.length);
 }
 // A draft changed or unapproved while preparing the package cannot be exported.
 await request(approved);
 files['caption.txt']=strToU8(approved.caption+'\n\n'+approved.hashtags+'\n');
 files['alt-text.txt']=strToU8(approved.photos.map((p,i)=>String(i+1).padStart(2,'0')+': '+p.alt).join('\n')+'\n');
 const result=new Blob([zipSync(files,{level:0})],{type:'application/zip'});
 const url=URL.createObjectURL(result),a=document.createElement('a');
 try{a.href=url;a.download='PhotoStory-'+approved.id+'-v'+approved.version+'.zip';a.click();}
 finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
}
