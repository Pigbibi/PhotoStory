"""PhotoStory's own HTTPS/OIDC transport for the existing native task protocol.

No SDK distribution, old CLI gateway, polling, write retry, or worker authority.
The caller's persistent ledger owns operation identity and result validation.
"""
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

MAX_REQUEST_BYTES = MAX_RESPONSE_BYTES = 2_000_000
USER_AGENT = "Pigbibi-PhotoStory-Native/1.0"
FAILURE_CATEGORIES = {"unknown", "timeout", "transport_error", "setup_required", "invalid_json",
    "gateway_failed", "output_missing", "invalid_input", "input_too_large", "invalid_gateway_url",
    "invalid_oidc_url", "oidc_unavailable", "too_many_images", "invalid_input_path", "invalid_image",
    "gateway_request_too_large", "gateway_result_invalid"}
REQUEST_ID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


def validated_failure_diagnostic(data):
    if not isinstance(data, dict):
        return None
    category = data.get("category")
    if not isinstance(category, str):
        return None
    result = {}
    status = data.get("http_status")
    if type(status) is int and 400 <= status <= 599 and category == f"http_{status}":
        result.update(category=category, http_status=status)
    elif category in FAILURE_CATEGORIES:
        result["category"] = category
    else:
        return None
    request_id = data.get("request_id")
    if isinstance(request_id, str) and REQUEST_ID.fullmatch(request_id):
        result["request_id"] = request_id
    return result


def safe_failure_diagnostic(error):
    data = {"category": "unknown"}
    if isinstance(error, urllib.error.HTTPError) and type(error.code) is int and 400 <= error.code <= 599:
        data.update(category=f"http_{error.code}", http_status=error.code)
        headers = error.headers or {}
        data["request_id"] = headers.get("request-id") or headers.get("x-ms-request-id")
    elif isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        data["category"] = "timeout"
    elif isinstance(error, json.JSONDecodeError):
        data["category"] = "invalid_json"
    elif isinstance(error, KeyError):
        data["category"] = "setup_required"
    elif isinstance(error, OSError):
        data["category"] = "transport_error"
    elif isinstance(error, ValueError) and str(error) in FAILURE_CATEGORIES:
        data["category"] = str(error)
    return validated_failure_diagnostic(data)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('redirect_blocked')


def _text(value, limit):
    return (isinstance(value, str) and 0 < len(value) <= limit
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def _https(value, *, base=False):
    if not _text(value, 2000) or any(c.isspace() for c in value):
        raise ValueError('invalid_gateway_url')
    parsed = urllib.parse.urlsplit(value)
    parsed.port
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.fragment or (base and (parsed.query or parsed.path not in {'', '/'}))):
        raise ValueError('invalid_gateway_url')
    return parsed


def _strict_json(raw):
    def invalid(*_):
        raise ValueError('invalid_json')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: invalid()
            result[key] = value
        return result
    try:
        value = json.loads(raw, parse_constant=invalid, object_pairs_hook=pairs)
        if not isinstance(value, dict): invalid()
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('invalid_json') from None


def _read_json(opener, request, limit):
    try:
        with opener.open(request, timeout=45) as response:
            if type(response.status) is not int or not 200 <= response.status < 300:
                raise ValueError('native_http_rejected')
            length = response.headers.get('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > limit):
                raise ValueError('response_too_large')
            raw = response.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('response_too_large')
    except urllib.error.HTTPError:
        raise ValueError('native_http_rejected') from None
    except TimeoutError:
        raise TimeoutError('native_timeout') from None
    except (OSError, urllib.error.URLError):
        raise ValueError('native_transport_error') from None
    return _strict_json(raw)


def oidc_token(audience, *, opener=None):
    _https(audience)
    url = os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL', '')
    secret = os.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '')
    parsed = _https(url)
    if (not parsed.hostname.endswith('.actions.githubusercontent.com')
            or parsed.port not in (None, 443) or not _text(secret, 65536)):
        raise ValueError('invalid_oidc_url')
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query) if k != 'audience']
    query.append(('audience', audience))
    target = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                                     urllib.parse.urlencode(query), ''))
    request = urllib.request.Request(target, headers={
        'Authorization': 'Bearer ' + secret, 'User-Agent': USER_AGENT})
    result = _read_json(opener or urllib.request.build_opener(NoRedirect()), request, 65536)
    token = result.get('value')
    if not _text(token, 65536):
        raise ValueError('oidc_unavailable')
    return token


class NativeTaskClient:
    """Three caller methods only. Construction does not obtain a token or do I/O."""
    def __init__(self, resource, audience, *, opener=None, token=None):
        _https(resource, base=True)
        parsed_audience = _https(audience)
        if parsed_audience.query:
            raise ValueError('invalid_gateway_url')
        self.resource, self.audience = resource.rstrip('/'), audience
        self.opener = opener or urllib.request.build_opener(NoRedirect())
        self.token = token if token is not None else lambda: oidc_token(audience, opener=self.opener)

    def _request(self, method, path, body=None, idempotency_key=None):
        if idempotency_key is not None and not _text(idempotency_key, 200):
            raise ValueError('invalid_input')
        raw = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False,
                                                  separators=(',', ':')).encode('utf-8')
        if raw is not None and len(raw) > MAX_REQUEST_BYTES:
            raise ValueError('input_too_large')
        token = self.token()
        if not _text(token, 65536):
            raise ValueError('oidc_unavailable')
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                   'User-Agent': USER_AGENT}
        if idempotency_key is not None: headers['Idempotency-Key'] = idempotency_key
        request = urllib.request.Request(self.resource + path, data=raw, method=method, headers=headers)
        return _read_json(self.opener, request, MAX_RESPONSE_BYTES)

    def submit(self, request, idempotency_key):
        if (not isinstance(request, dict) or request.get('mode') != 'agent'
                or type(request.get('timeout_seconds')) is not int or request['timeout_seconds'] != 60
                or not _text(idempotency_key, 200)):
            raise ValueError('invalid_input')
        return self._request('POST', '/v1/tasks', request, idempotency_key)

    @staticmethod
    def _task_path(task_id):
        if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', task_id):
            raise ValueError('invalid_input')
        return '/v1/tasks/' + task_id

    def get(self, task_id):
        return self._request('GET', self._task_path(task_id))

    def cancel(self, task_id):
        return self._request('POST', self._task_path(task_id) + '/cancel', {})


if __name__ == '__main__':
    print('Legacy gateway command retired; use the configured PhotoStory native caller.')
    raise SystemExit(1)
