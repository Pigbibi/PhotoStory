const day = (date) => date.toISOString().slice(0,10);
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_dates');
  const parsed = new Date(value+'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || day(parsed)!==value) throw new Error('invalid_dates');
  return parsed;
}
export function jobInput(b, now = new Date()) {
  const folder=String(b.folder||'').trim().replace(/^\/+|\/+$/g,'');
  if (!folder || folder.length>300 || folder.split('/').some(x=>!x||x==='.'||x==='..') || /[\\?#]/.test(folder)) throw new Error('invalid_folder');
  const locationHint=String(b.locationHint||'').trim();
  if(locationHint.length>160) throw new Error('invalid_location_hint');
  const range=b.range, maxPhotos=b.maxPhotos??50;
  if (!Number.isInteger(maxPhotos) || maxPhotos<1 || maxPhotos>100) throw new Error('invalid_batch_size');
  let start=null,end=null;
  const selection={range};
  if (range==='custom') {
    const a=dateValue(b.start), z=dateValue(b.end);
    if(z<a) throw new Error('invalid_dates');
    start=day(a); end=day(new Date(z.getTime()+86400000));
    selection.start=b.start; selection.end=b.end;
  } else if (['1m','3m','6m','12m'].includes(range)) {
    const today=dateValue(day(new Date(now.getTime()+8*3600000)));
    const months=Number(range.slice(0,-1));
    const monthStart=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-months,1));
    const lastDay=new Date(Date.UTC(monthStart.getUTCFullYear(),monthStart.getUTCMonth()+1,0)).getUTCDate();
    monthStart.setUTCDate(Math.min(today.getUTCDate(),lastDay));
    start=day(monthStart); end=day(new Date(today.getTime()+86400000));
  } else if(range!=='all') throw new Error('invalid_range');
  return {pipeline:2,folder,selection,start,end,maxPhotos,locationHint,progress:{phase:'scanning',total:0,processed:0,batches:0}};
}
export function progressInput(value, previous={}) {
  if (!value || !['scanning','processing','complete'].includes(value.phase)) throw new Error('invalid_progress');
  const result={phase:value.phase};
  for (const key of ['total','processed','batches']) {
    const n=value[key];
    if(!Number.isSafeInteger(n)||n<0||n>1e9||n<(previous[key]||0)) throw new Error('invalid_progress');
    result[key]=n;
  }
  if(value.analyzed!==undefined){
    if(!Number.isSafeInteger(value.analyzed)||value.analyzed<0||value.analyzed<(previous.analyzed||0)||value.analyzed>result.processed)throw new Error('invalid_progress');
    result.analyzed=value.analyzed;
  }
  if(result.processed>result.total) throw new Error('invalid_progress');
  return result;
}
