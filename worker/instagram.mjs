import * as auth from './auth.mjs';
const DAY=86400000;
const SCOPES=['instagram_business_basic','instagram_business_content_publish'];
const USERNAME=/^[A-Za-z0-9._]{1,30}$/;
function config(e){
 try{
  const redirect=new URL(e.INSTAGRAM_REDIRECT_URI);
  if(!/^\d+$/.test(e.INSTAGRAM_CLIENT_ID)||!e.INSTAGRAM_CLIENT_SECRET||!e.TOKEN_ENCRYPTION_KEY||!USERNAME.test(e.INSTAGRAM_USERNAME)||redirect.protocol!=='https:'||redirect.username||redirect.password||redirect.search||redirect.hash||redirect.pathname!=='/auth/instagram/callback')return null;
  return {client:e.INSTAGRAM_CLIENT_ID,redirect:redirect.href,origin:redirect.origin,username:e.INSTAGRAM_USERNAME.toLowerCase()};
 }catch{return null;}
}
export async function status(e){
 const c=config(e),base={configured:Boolean(c),connected:false};
 if(!c)return base;
 try{
  const encrypted=await auth.get(e,'instagram');if(!encrypted)return base;
  const saved=await auth.unseal(e,encrypted);
  if(saved.username?.toLowerCase()!==c.username||saved.client!==c.client||!Number.isSafeInteger(saved.expires))return base;
  const renewal=await auth.get(e,'instagram-refresh');
  const current=renewal?.tokenHash===await auth.hash(JSON.stringify(encrypted));
  return {...base,connected:saved.expires>Date.now(),username:saved.username,expires:saved.expires,
   autoRefresh:true,refreshState:saved.expires<=Date.now()?'expired':current&&renewal.state==='failed'?'failed':'automatic',
   ...(Number.isSafeInteger(saved.refreshedAt)?{lastRenewedAt:saved.refreshedAt}:{})};
 }catch{return base;}
}
export async function start(r,e){
 const c=config(e);if(!c||new URL(r.url).origin!==c.origin)return auth.redirect('/?error=instagram_not_configured');
 if(!e.AUTH_LIMITER)return new Response('Login protection is not configured.',{status:503});
 if(!(await e.AUTH_LIMITER.limit({key:'photostory:oauth-start'})).success)return new Response('Please retry login in a minute.',{status:429,headers:{'Retry-After':'60'}});
 const state=auth.random();
 await auth.put(e,'ig-oauth:'+await auth.hash(state),{session:await auth.hash(auth.cookies(r)[auth.cookieName]),...c},Date.now()+600000);
 const u=new URL('https://www.instagram.com/oauth/authorize');
 u.search=new URLSearchParams({client_id:c.client,redirect_uri:c.redirect,response_type:'code',scope:SCOPES.join(','),state,enable_fb_login:'false'});
 return auth.redirect(u.href,[auth.cookie('__Host-ps-ig',state,600)]);
}
async function request(url,options={}){
 // Meta's token exchange requires server-side query parameters. Never log these
 // URLs or return provider errors, redirects, codes or tokens to the browser.
 const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(!r.body)throw Object.assign(new Error('instagram_connection_failed'),{httpStatus:r.status});
 const reader=r.body.getReader(),parts=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new Error('instagram_connection_failed');}parts.push(value);}
 const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
 if(!r.ok){
  const error=Object.assign(new Error('instagram_connection_failed'),{httpStatus:r.status});
  try{const data=JSON.parse(new TextDecoder().decode(bytes));for(const key of ['code','error_subcode'])if(Number.isSafeInteger(data?.error?.[key]))error[key]=data.error[key];}catch{}
  throw error;
 }
 try{return JSON.parse(new TextDecoder().decode(bytes),(key,value,context)=>
  (key==='id'||key==='user_id')&&typeof value==='number'&&/^\d{1,32}$/.test(context?.source||'')?context.source:value);}catch{throw Object.assign(new Error('instagram_connection_failed'),{httpStatus:r.status,category:'invalid_json'});}
}
function single(value){
 if(value&&Array.isArray(value.data)){if(value.data.length!==1)throw new Error('instagram_connection_failed');return value.data[0];}
 return value;
}
const identifier=v=>typeof v==='string'&&/^\d{1,32}$/.test(v);
const normalizeId=v=>identifier(v)?v:Number.isSafeInteger(v)&&v>0?String(v):null;
export async function finish(r,e){
 const c=config(e),u=new URL(r.url),state=u.searchParams.get('state');
 if(!c||u.origin!==c.origin||!state||state.length>200||auth.cookies(r)['__Host-ps-ig']!==state)throw new Error('invalid_oauth_state');
 const binding=await auth.hash(auth.cookies(r)[auth.cookieName]);
 const row=await e.DB.prepare("DELETE FROM state WHERE key=? AND expires>? AND json_extract(value,'$.session')=? RETURNING value").bind('ig-oauth:'+await auth.hash(state),Date.now(),binding).first();
 if(!row)throw new Error('invalid_oauth_state');
 const saved=JSON.parse(row.value);
 if(saved.username!==c.username||saved.client!==c.client||saved.redirect!==c.redirect)throw new Error('invalid_oauth_state');
 const clear=[auth.cookie('__Host-ps-ig','',0)];let stage='consent',shape;
 try{
  const code=u.searchParams.get('code');if(u.searchParams.has('error')||!code||code.length>8192)throw new Error('instagram_connection_failed');
  const body=new FormData();for(const [key,value] of Object.entries({client_id:c.client,client_secret:e.INSTAGRAM_CLIENT_SECRET,grant_type:'authorization_code',redirect_uri:c.redirect,code}))body.set(key,value);
  stage='short_token_request';
  const short=single(await request('https://api.instagram.com/oauth/access_token',{method:'POST',body}));
  stage='short_token_shape';shape={userIdType:typeof short?.user_id,permissionsType:typeof short?.permissions,permissionsArray:Array.isArray(short?.permissions)};
  const scopedId=normalizeId(short?.user_id);
  if(typeof short?.access_token!=='string'||!short.access_token||!scopedId)throw new Error('instagram_connection_failed');
  stage='permissions';shape=undefined;
  const permissions=typeof short.permissions==='string'?short.permissions.split(',').map(s=>s.trim()):short.permissions;
  if(!Array.isArray(permissions)||!permissions.every(s=>typeof s==='string')||!SCOPES.every(s=>permissions.includes(s)))throw new Error('instagram_connection_failed');
  const exchange=new URL('https://graph.instagram.com/access_token');exchange.search=new URLSearchParams({grant_type:'ig_exchange_token',client_secret:e.INSTAGRAM_CLIENT_SECRET,access_token:short.access_token});
  stage='long_token_request';const long=await request(exchange);stage='long_token_shape';
  if(typeof long?.access_token!=='string'||!long.access_token||!Number.isSafeInteger(long.expires_in)||long.expires_in<300||long.expires_in>7776000)throw new Error('instagram_connection_failed');
  const me=new URL('https://graph.instagram.com/v26.0/me');me.search=new URLSearchParams({fields:'id,user_id,username,account_type',access_token:long.access_token});
  stage='profile_request';const profile=single(await request(me));stage='profile_identity';shape={idType:typeof profile?.id,userIdType:typeof profile?.user_id,scopedIdMatches:normalizeId(profile?.id)===scopedId,usernameMatches:profile?.username?.toLowerCase()===c.username,professional:['BUSINESS','MEDIA_CREATOR'].includes(String(profile?.account_type).toUpperCase())};
  if(!profile||normalizeId(profile.id)!==scopedId||!normalizeId(profile.user_id)||!USERNAME.test(profile.username)||profile.username.toLowerCase()!==c.username||!['BUSINESS','MEDIA_CREATOR'].includes(String(profile.account_type).toUpperCase()))throw new Error('instagram_connection_failed');
  stage='session';shape=undefined;
  if(!await auth.session(r,e))throw new Error('instagram_connection_failed');
  stage='storage';
  await auth.put(e,'instagram',await auth.seal(e,{access:long.access_token,client:c.client,userId:normalizeId(profile.user_id),scopedId,username:profile.username,accountType:profile.account_type,permissions:SCOPES,issuedAt:Date.now(),expires:Date.now()+long.expires_in*1000}));
  await auth.remove(e,'instagram-diagnostic');
  return auth.redirect('/?instagram=connected',clear);
 }catch(err){
  // Store no provider text, URLs, codes, identities or credentials.
  try{await auth.put(e,'instagram-diagnostic',{stage,...(shape?{shape}:{}),...(Number.isInteger(err?.httpStatus)?{httpStatus:err.httpStatus}:{}),category:err?.category==='invalid_json'?'invalid_json':['TypeError','TimeoutError','AbortError','SyntaxError'].includes(err?.name)?err.name:'validation'},Date.now()+600000);}catch{}
  return auth.redirect('/?error=instagram_connection_failed',clear);
 }
}

// Server-only publishing credentials. Never include this object in an API response.
export async function publishingAccount(e){
 const c=config(e);if(!c)throw new Error('instagram_not_connected');
 let saved;try{saved=await auth.unseal(e,await auth.get(e,'instagram'));}catch{throw new Error('instagram_not_connected');}
 if(saved.client!==c.client||saved.username?.toLowerCase()!==c.username||saved.expires<Date.now()+600000||!identifier(saved.userId)||!saved.access||!SCOPES.every(s=>saved.permissions?.includes(s)))throw new Error('instagram_not_connected');
 return {...saved,origin:c.origin};
}
export async function publishingRequest(account,path,body){
 if(!/^\d{1,32}(?:\/(?:media|media_publish))?$/.test(path))throw new Error('publication_failed');
 const url=new URL('https://graph.instagram.com/v26.0/'+path);
 if(!body)url.searchParams.set('fields','status_code');
 try{return await request(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+account.access},...(body?{body:new URLSearchParams(body)}:{})});}
 catch(error){throw Object.assign(new Error('publication_failed'),safeFailure(error));}
}

// Maintenance only: never publishes, changes scopes or replaces a newer login.
export async function refresh(e,now=Date.now()){
 const c=config(e);if(!c)return;
 const row=await e.DB.prepare("SELECT value FROM state WHERE key='instagram'").first();
 if(!row)return;
 let saved;try{saved=await auth.unseal(e,JSON.parse(row.value));}catch{return;}
 if(saved.client!==c.client||saved.username?.toLowerCase()!==c.username||!identifier(saved.userId)||
    typeof saved.access!=='string'||!saved.access||!SCOPES.every(s=>saved.permissions?.includes(s))||
    !Number.isSafeInteger(saved.expires)||saved.expires<=now||saved.expires>=now+30*DAY)return;
 // Legacy connections had a 60-day token but no issuance timestamp.
 const issued=saved.refreshedAt??saved.issuedAt??saved.expires-60*DAY;
 if(!Number.isSafeInteger(issued)||now-issued<DAY)return;
 const claim={tokenHash:await auth.hash(row.value),state:'refreshing',checkedAt:now,nextAttemptAt:now+DAY};
 const claimValue=JSON.stringify(claim);
 const lock=await e.DB.prepare("INSERT INTO state(key,value,expires) SELECT 'instagram-refresh',?,NULL WHERE EXISTS(SELECT 1 FROM state WHERE key='instagram' AND value=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=NULL WHERE json_extract(state.value,'$.tokenHash')<>? OR json_extract(state.value,'$.nextAttemptAt')<=?")
  .bind(claimValue,row.value,claim.tokenHash,now).run();
 if(lock.meta.changes!==1)return;
 try{
  const url=new URL('https://graph.instagram.com/refresh_access_token');
  url.search=new URLSearchParams({grant_type:'ig_refresh_token',access_token:saved.access});
  const result=await request(url);
  if(typeof result?.access_token!=='string'||!result.access_token||result.token_type?.toLowerCase()!=='bearer'||
     !Number.isSafeInteger(result.expires_in)||result.expires_in<86400||result.expires_in>5184000||
     now+result.expires_in*1000<=saved.expires)throw new Error('instagram_refresh_failed');
  const next=JSON.stringify(await auth.seal(e,{...saved,access:result.access_token,expires:now+result.expires_in*1000,refreshedAt:now}));
  const changed=await e.DB.prepare("UPDATE state SET value=? WHERE key='instagram' AND value=?").bind(next,row.value).run();
  if(changed.meta.changes!==1)return;
  await e.DB.prepare("UPDATE state SET value=? WHERE key='instagram-refresh' AND value=?")
   .bind(JSON.stringify({...claim,tokenHash:await auth.hash(next),state:'ok'}),claimValue).run();
 }catch{
  // Retain the still-valid connection, expose no provider text or credential URLs.
  await e.DB.prepare("UPDATE state SET value=? WHERE key='instagram-refresh' AND value=?")
   .bind(JSON.stringify({...claim,state:'failed'}),claimValue).run();
 }
}

// Only fixed categories and numeric metadata can leave the provider boundary.
export function safeFailure(error,stage='account_check'){
 const result={at:Date.now(),stage,category:[10,190,200].includes(error?.code)||error?.httpStatus===401||error?.httpStatus===403?'authorization':'unknown'};
 for(const key of ['httpStatus','code','error_subcode'])if(Number.isSafeInteger(error?.[key]))result[key]=error[key];
 return result;
}

// Read-only, machine-authenticated account check; never creates media.
export async function publishingHealth(e){
 try{
  const a=await publishingAccount(e);
  const url=new URL('https://graph.instagram.com/v26.0/me');url.searchParams.set('fields','id,username');
  const p=await request(url,{headers:{Authorization:'Bearer '+a.access}});
  if(p.username?.toLowerCase()!==a.username.toLowerCase())throw new Error('instagram_not_connected');
  return {ok:true,checkedAt:Date.now()};
 }catch(error){return {ok:false,...safeFailure(error)};}
}

// Read-only account inventory; never follow provider-supplied pagination URLs.
export async function mediaHistoryPage(e,after=null){
 const account=await publishingAccount(e);
 if(after!==null&&(typeof after!=='string'||after.length>2048||!after))throw new Error('invalid_request');
 const url=new URL('https://graph.instagram.com/v26.0/'+account.userId+'/media');
 url.searchParams.set('fields','id,media_type,timestamp,children.limit(100){id,media_type}');
 url.searchParams.set('limit','25');
 if(after)url.searchParams.set('after',after);
 const result=await request(url,{headers:{Authorization:'Bearer '+account.access}});
 if(!Array.isArray(result.data)||result.data.length>25)throw new Error('instagram_connection_failed');
 const records=result.data.map(p=>{
  if(!identifier(p.id)||!['IMAGE','VIDEO','CAROUSEL_ALBUM'].includes(p.media_type)||!Number.isFinite(Date.parse(p.timestamp)))throw new Error('instagram_connection_failed');
  const children=p.media_type==='CAROUSEL_ALBUM'?p.children?.data:[p];
  if(!Array.isArray(children)||children.length>100||p.children?.paging?.next||children.some(c=>!identifier(c.id)||!['IMAGE','VIDEO'].includes(c.media_type)))throw new Error('instagram_connection_failed');
  return {id:p.id,at:Date.parse(p.timestamp),photos:children.filter(c=>c.media_type==='IMAGE').length,photoIds:children.filter(c=>c.media_type==='IMAGE').map(c=>c.id)};
 });
 const next=result.paging?.next?result.paging?.cursors?.after:null;
 if(next!==null&&(typeof next!=='string'||!next||next.length>2048||next===after))throw new Error('instagram_connection_failed');
 return {userId:account.userId,username:account.username,records,after:next};
}

function mediaURL(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.port||u.username||u.password)return false;
  return u.hostname.endsWith('.cdninstagram.com')||u.hostname.endsWith('.fbcdn.net');
 }catch{return false;}
}

// Return short-lived provider media URLs only to the machine-authenticated
// processor. They are never persisted in D1 or returned to browser sessions.
export async function mediaHistoryMediaPage(e,offset=0){
 const account=await publishingAccount(e),saved=await auth.get(e,'instagram-history:'+account.userId);
 if(!saved||saved.after!==null||!Number.isSafeInteger(offset)||offset<0||offset>saved.records.length)throw new Error('history_not_complete');
 const records=saved.records.slice(offset,offset+5),items=[];
 for(const record of records){
  if(!identifier(record.id))throw new Error('instagram_connection_failed');
  const url=new URL('https://graph.instagram.com/v26.0/'+record.id);
  url.searchParams.set('fields','id,media_type,media_url,children.limit(100){id,media_type,media_url}');
  const value=await request(url,{headers:{Authorization:'Bearer '+account.access}});
  if(value.id!==record.id||!['IMAGE','CAROUSEL_ALBUM'].includes(value.media_type))throw new Error('instagram_connection_failed');
  const children=value.media_type==='CAROUSEL_ALBUM'?value.children?.data:[value];
  if(!Array.isArray(children)||children.length>100||value.children?.paging?.next)throw new Error('instagram_connection_failed');
  for(const child of children){if(child.media_type!=='IMAGE')continue;if(!identifier(child.id)||!mediaURL(child.media_url))throw new Error('instagram_connection_failed');items.push({instagramId:child.id,mediaUrl:child.media_url});}
 }
 const next=offset+records.length<saved.records.length?offset+records.length:null;
 return {algorithm:'dhash-v1',items,offset,after:next};
}
