// Both HTTP surfaces that answer callers use these two shapes: the browser API
// and the machine API. A second copy of the response helper is how the two
// drifted apart in the first place.
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export const failure = (code, status) => json({ error: code }, status);

// A handler rejects a request by throwing its own code. Only these codes reach
// the client; anything else is an unexpected fault and must not leak runtime
// detail, so it collapses to one generic code.
export const KNOWN_CODES = new Set([
  'storage_limit', 'storage_request_limit', 'storage_busy', 'storage_conflict', 'storage_unavailable',
  'source_unavailable', 'source_authentication_failed', 'source_metadata_unavailable', 'source_changed',
  'original_format', 'original_too_large', 'approval_required',
  'invalid_oauth_state', 'github_not_allowed', 'github_exchange_failed', 'microsoft_exchange_failed',
  'invalid_dates', 'invalid_range', 'invalid_language', 'invalid_framing', 'invalid_settings',
  'instagram_not_connected', 'invalid_publish_image', 'publication_conflict', 'publication_incomplete',
  'invalid_action', 'invalid_batch_size', 'invalid_progress', 'invalid_location_hint', 'invalid_folder',
  'version_conflict', 'save_before_approval', 'request_too_large', 'duplicate_draft',
  'photo_already_used', 'unsafe_photo', 'invalid_batch', 'invalid_image',
  'onedrive_not_connected', 'reauthorization_required',
  'history_not_complete', 'history_match_contract', 'history_match_setup',
]);

export const FALLBACK_CODE = 'request_failed';

export const errorCode = error =>
  KNOWN_CODES.has(error?.message) ? error.message : FALLBACK_CODE;

// A code that names a conflict keeps its own status; every other rejected
// request is a bad request.
export const errorResponse = error => {
  const code = errorCode(error);
  return failure(code, code === 'version_conflict' ? 409 : 400);
};
