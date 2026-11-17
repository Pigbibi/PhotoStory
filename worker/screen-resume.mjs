import {failure, json} from './http.mjs';

const project = 'Pigbibi/PhotoStory';
const terminal = new Set(['completed', 'failed', 'cancelled', 'invalid_output']);
const bytes = new TextEncoder();
export const screenWakePattern = /^[0-9a-f]{64}$/;
export const taskIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const base64url = value => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

async function trigger(e, wake) {
  const pem = e.SCREEN_RESUME_APP_KEY.match(/^-----BEGIN PRIVATE KEY-----([\s\S]+)-----END PRIVATE KEY-----\s*$/);
  if (!pem) throw new Error('screen_resume_key');
  const privateKey = Uint8Array.from(atob(pem[1]), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', privateKey,
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const claims = base64url(bytes.encode(JSON.stringify({iat: now - 30, exp: now + 540, iss: e.SCREEN_RESUME_APP_ID})));
  const input = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' + claims;
  const jwt = input + '.' + base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes.encode(input))));
  const headers = {
    'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
    'User-Agent': 'PhotoStory-Screen-Resume', 'X-GitHub-Api-Version': '2026-03-10',
  };
  const post = (endpoint, token, body) => fetch('https://api.github.com/' + endpoint, {
    method: 'POST', headers: {...headers, Authorization: 'Bearer ' + token}, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  const installation = await post(`app/installations/${e.SCREEN_RESUME_INSTALLATION_ID}/access_tokens`, jwt,
    {repositories: ['PhotoStory'], permissions: {actions: 'write'}});
  if (installation.status !== 201) {
    await installation.body?.cancel();
    throw new Error('screen_resume_auth');
  }
  const {token} = await installation.json();
  if (typeof token !== 'string' || !token) throw new Error('screen_resume_auth');
  const response = await post(`repos/${project}/actions/workflows/processor.yml/dispatches`, token,
    {ref: 'main', inputs: {resume_screen: wake}});
  await response.body?.cancel();
  if (!response.ok) throw new Error('screen_resume_dispatch');
}

export async function resumeScreen(request, e, ctx, readBody) {
  const secret = e.SCREEN_COMPLETION_SECRET;
  if (typeof secret !== 'string' || bytes.encode(secret).length < 32 ||
      !/^[1-9][0-9]*$/.test(e.SCREEN_RESUME_APP_ID || '') ||
      !/^[1-9][0-9]*$/.test(e.SCREEN_RESUME_INSTALLATION_ID || '') ||
      !e.SCREEN_RESUME_APP_KEY)
    return failure('not_found', 404);

  const stamp = request.headers.get('X-Callback-Timestamp') || '';
  const mac = request.headers.get('X-Callback-Signature') || '';
  if (!/^[0-9]{10}$/.test(stamp) || Math.abs(Date.now() / 1000 - Number(stamp)) > 300 ||
      !/^sha256=[0-9a-f]{64}$/.test(mac))
    return failure('unauthorized', 401);
  const body = await readBody();
  const prefix = bytes.encode(stamp + '.');
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const key = await crypto.subtle.importKey('raw', bytes.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  const signature = Uint8Array.from(mac.slice(7).match(/../g), n => Number.parseInt(n, 16));
  if (!await crypto.subtle.verify('HMAC', key, signature, signed)) return failure('unauthorized', 401);
  const event = JSON.parse(new TextDecoder().decode(body));
  if (!event || event.name !== 'task.terminal' || event.project !== project ||
      !Number.isSafeInteger(event.event_id) || event.event_id < 1 ||
      typeof event.task_id !== 'string' || !taskIdPattern.test(event.task_id) ||
      !Number.isSafeInteger(event.revision) || event.revision < 1 || !terminal.has(event.status))
    return failure('invalid_request', 400);

  // Claim once while the exact checkpoint is parked. The scheduled processor
  // remains the recovery path if GitHub is unavailable or its reply is lost.
  const row = await e.DB.prepare(`UPDATE jobs SET body=json_set(body,'$.screenWait.dispatched',1)
    WHERE status='pending' AND COALESCE(json_extract(body,'$.stopRequested'),0)!=1
      AND json_extract(body,'$.screenWait.taskId')=? AND json_extract(body,'$.screenWait.revision')=?
      AND json_extract(body,'$.screenWait.dispatched')=0
    RETURNING json_extract(body,'$.screenWait.wake') AS wake`).bind(event.task_id, event.revision).first();
  if (row) {
    ctx.waitUntil(trigger(e, row.wake).catch(() => console.warn('screen_resume_dispatch_failed')));
    return json({accepted: true}, 202);
  }
  const known = await e.DB.prepare(`SELECT status, json_extract(body,'$.screenWait.dispatched') AS dispatched,
    json_extract(body,'$.stopRequested') AS stopped FROM jobs WHERE json_extract(body,'$.screenWait.taskId')=?
    AND json_extract(body,'$.screenWait.revision')=? LIMIT 1`).bind(event.task_id, event.revision).first();
  // The task can finish before the submitter has recorded the wait. The
  // service may redeliver; unrelated or unparked events cannot trigger work.
  if (!known || (known.status === 'running' && !known.dispatched && !known.stopped))
    return failure('checkpoint_pending', 503);
  return json({accepted: false});
}
