import * as auth from './auth.mjs';
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
  return {...base,connected:saved.expires>Date.now(),username:saved.username,expires:saved.expires};
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
 const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!r.ok||!r.body)throw Object.assign(new Error('instagram_connection_failed'),{httpStatus:r.status});
 const reader=r.body.getReader(),parts=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new Error('instagram_connection_failed');}parts.push(value);}
 const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw Object.assign(new Error('instagram_connection_failed'),{httpStatus:r.status,category:'invalid_json'});}
}
function single(value){
 if(value&&Array.isArray(value.data)){if(value.data.length!==1)throw new Error('instagram_connection_failed');return value.data[0];}
 return value;
}
const identifier=v=>typeof v==='string'&&/^\d{1,32}$/.test(v);
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
  if(typeof short?.access_token!=='string'||!short.access_token||!identifier(short.user_id)||typeof short.permissions!=='string')throw new Error('instagram_connection_failed');
  stage='permissions';shape=undefined;
  const permissions=short.permissions.split(',').map(s=>s.trim());if(!SCOPES.every(s=>permissions.includes(s)))throw new Error('instagram_connection_failed');
  const exchange=new URL('https://graph.instagram.com/access_token');exchange.search=new URLSearchParams({grant_type:'ig_exchange_token',client_secret:e.INSTAGRAM_CLIENT_SECRET,access_token:short.access_token});
  stage='long_token_request';const long=await request(exchange);stage='long_token_shape';
  if(typeof long?.access_token!=='string'||!long.access_token||!Number.isSafeInteger(long.expires_in)||long.expires_in<300||long.expires_in>7776000)throw new Error('instagram_connection_failed');
  const me=new URL('https://graph.instagram.com/v26.0/me');me.search=new URLSearchParams({fields:'id,user_id,username,account_type',access_token:long.access_token});
  stage='profile_request';const profile=single(await request(me));stage='profile_identity';shape={idType:typeof profile?.id,userIdType:typeof profile?.user_id,scopedIdMatches:profile?.id===short.user_id,usernameMatches:profile?.username?.toLowerCase()===c.username,professional:['BUSINESS','MEDIA_CREATOR'].includes(String(profile?.account_type).toUpperCase())};
  if(!profile||profile.id!==short.user_id||!identifier(profile.user_id)||!USERNAME.test(profile.username)||profile.username.toLowerCase()!==c.username||!['BUSINESS','MEDIA_CREATOR'].includes(String(profile.account_type).toUpperCase()))throw new Error('instagram_connection_failed');
  stage='session';shape=undefined;
  if(!await auth.session(r,e))throw new Error('instagram_connection_failed');
  stage='storage';
  await auth.put(e,'instagram',await auth.seal(e,{access:long.access_token,client:c.client,userId:profile.user_id,scopedId:profile.id,username:profile.username,accountType:profile.account_type,permissions:SCOPES,expires:Date.now()+long.expires_in*1000}));
  await auth.remove(e,'instagram-diagnostic');
  return auth.redirect('/?instagram=connected',clear);
 }catch(err){
  // Store no provider text, URLs, codes, identities or credentials.
  try{await auth.put(e,'instagram-diagnostic',{stage,...(shape?{shape}:{}),...(Number.isInteger(err?.httpStatus)?{httpStatus:err.httpStatus}:{}),category:err?.category==='invalid_json'?'invalid_json':['TypeError','TimeoutError','AbortError','SyntaxError'].includes(err?.name)?err.name:'validation'},Date.now()+600000);}catch{}
  return auth.redirect('/?error=instagram_connection_failed',clear);
 }
}
