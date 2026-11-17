import {failure, json} from './http.mjs';

const project = 'Pigbibi/PhotoStory';
const terminal = new Set(['completed', 'failed', 'cancelled', 'invalid_output']);
const bytes = new TextEncoder();
export const screenWakePattern = /^[0-9a-f]{64}$/;
export const taskIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const base64url = value => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

async function installationToken(e) {
  const pem = e.SCREEN_RESUME_APP_KEY.match(/^-----BEGIN PRIVATE KEY-----([\s\S]+)-----END PRIVATE KEY-----\s*$/);
  if (!pem) throw new Error('screen_resume_key');
  const privateKey = Uint8Array.from(atob(pem[1]), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', privateKey,
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const claims = base64url(bytes.encode(JSON.stringify({iat: now - 30, exp: now + 540, iss: e.SCREEN_RESUME_APP_ID})));
  const input = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' + claims;
  const jwt = input + '.' + base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes.encode(input))));
  const installation = await post(`app/installations/${e.SCREEN_RESUME_INSTALLATION_ID}/access_tokens`, jwt,
    {repositories: ['PhotoStory'], permissions: {actions: 'write'}});
  if (installation.status !== 201) {
    await installation.body?.cancel();
    throw new Error('screen_resume_auth');
  }
  const {token} = await installation.json();
  if (typeof token !== 'string' || !token) throw new Error('screen_resume_auth');
  return token;
}

function post(endpoint, token, body) {
  const headers = {
    'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
    'User-Agent': 'PhotoStory-Screen-Resume', 'X-GitHub-Api-Version': '2026-03-10',
  };
  return fetch('https://api.github.com/' + endpoint, {
    method: 'POST', headers: {...headers, Authorization: 'Bearer ' + token}, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
}

async function dispatch(e, {id, wake}) {
  const record = (armed, state) => e.DB.prepare(`UPDATE jobs SET body=json_set(body,
      '$.screenWait.dispatched',?,'$.screenWait.dispatchState',?)
    WHERE id=? AND json_extract(body,'$.screenWait.wake')=?
      AND json_extract(body,'$.screenWait.dispatchState')='sending'`).bind(armed, state, id, wake).run();
  let token;
  try {
    token = await installationToken(e);
  } catch {
    // No dispatch was attempted. A redelivery may safely try again.
    await record(0, 'retryable');
    return failure('screen_resume_auth', 503);
  }
  const code = await post(`repos/${project}/actions/workflows/processor.yml/dispatches`, token,
    {ref: 'main', inputs: {resume_screen: wake}}).then(async response => {
      await response.body?.cancel().catch(() => {});
      return response.status;
    }, () => 0);
  if (code >= 200 && code < 300) {
    await record(1, 'accepted');
    return json({accepted: true}, 202);
  }
  if ([400, 401, 403, 404, 422, 429].includes(code)) {
    await record(0, 'retryable');
    return failure('screen_resume_rejected', 503);
  }
  // A lost reply may have started a run. Leave its wake claimable and let
  // the scheduled processor recover the checkpoint if nothing claimed it.
  await record(1, 'unknown');
  return failure('screen_resume_unknown', 409);
}

export async function resumeScreen(request, e, readBody) {
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
  const row = await e.DB.prepare(`UPDATE jobs SET body=json_set(body,'$.screenWait.dispatched',1,'$.screenWait.dispatchState','sending')
    WHERE status='pending' AND COALESCE(json_extract(body,'$.stopRequested'),0)!=1
      AND json_extract(body,'$.screenWait.taskId')=? AND json_extract(body,'$.screenWait.revision')=?
      AND json_extract(body,'$.screenWait.dispatched')=0
    RETURNING id, json_extract(body,'$.screenWait.wake') AS wake`).bind(event.task_id, event.revision).first();
  if (row) return dispatch(e, row);
  const known = await e.DB.prepare(`SELECT status, json_extract(body,'$.screenWait.dispatched') AS dispatched,
    json_extract(body,'$.screenWait.dispatchState') AS dispatchState,
    json_extract(body,'$.stopRequested') AS stopped FROM jobs WHERE json_extract(body,'$.screenWait.taskId')=?
    AND json_extract(body,'$.screenWait.revision')=? LIMIT 1`).bind(event.task_id, event.revision).first();
  // The task can finish before the submitter has recorded the wait. The
  // service may redeliver; unrelated or unparked events cannot trigger work.
  if (!known || (known.status === 'running' && !known.dispatched && !known.stopped))
    return failure('checkpoint_pending', 503);
  if (known.status === 'pending' && !known.stopped) {
    if (known.dispatchState === 'sending' || !known.dispatched) return failure('screen_resume_pending', 503);
    if (known.dispatchState !== 'accepted') return failure('screen_resume_unknown', 409);
  }
  return json({accepted: false});
}
