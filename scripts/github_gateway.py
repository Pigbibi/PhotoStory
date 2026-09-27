#!/usr/bin/env python3
"""PhotoStory's bounded client for the existing CodexGateway OIDC service.

The public workflow cannot load an action from the private AIGateway repository.
Codex authentication and model execution remain on the gateway service host.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request


MAX_REQUEST_BYTES = 15_000_000  # Requires a 16 MB service-side cap for photo batches.


def regular_bytes(path, limit):
    import stat

    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("invalid_input")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("input_too_large")
    return data


def endpoint(base):
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid_gateway_url")
    return base.rstrip("/") + "/v1/codex"


def oidc_token(audience):
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("invalid_oidc_url")
    separator = "&" if parsed.query else "?"
    request = urllib.request.Request(
        url + separator + urllib.parse.urlencode({"audience": audience}),
        headers={"Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        token = json.load(response).get("value")
    if not isinstance(token, str) or not token:
        raise ValueError("oidc_unavailable")
    return token


def attachment(path, limit):
    data = regular_bytes(path, limit)
    return {"name": Path(path).name, "suffix": Path(path).suffix,
            "content_base64": base64.b64encode(data).decode("ascii")}


def main():
    parser = argparse.ArgumentParser()
    for name in ("prompt-file", "output-schema", "out", "cwd"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--image", action="append", default=[])
    parser.add_argument("--providers", choices=["codex"], required=True)
    parser.add_argument("--sandbox", choices=["read-only"], required=True)
    parser.add_argument("--ask-for-approval", choices=["never"], required=True)
    parser.add_argument("--complexity", choices=["medium"], required=True)
    parser.add_argument("--timeout-seconds", type=int, choices=[600], required=True)
    args = parser.parse_args()
    if len(args.image) > 24:
        raise ValueError("too_many_images")
    work = Path(args.cwd).resolve()
    inputs = [args.prompt_file, args.output_schema, *args.image]
    if any(Path(path).resolve().parent != work for path in inputs):
        raise ValueError("invalid_input_path")
    images = [attachment(path, 1_800_000) for path in args.image]
    if any(image["suffix"].lower() != ".jpg" for image in images):
        raise ValueError("invalid_image")
    payload = {
        "prompt": regular_bytes(args.prompt_file, 128_000).decode("utf-8"),
        "output_schema": attachment(args.output_schema, 64_000),
        "images": images,
        "timeout_seconds": 600,
        "sandbox": "read-only",
        "ask_for_approval": "never",
        "provider_chain": "codex",
        "complexity": "medium",
        "search": False,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_REQUEST_BYTES:
        raise ValueError("gateway_request_too_large")
    token = oidc_token(os.environ.get("CODEX_GATEWAY_SERVICE_AUDIENCE", "codex-gateway"))
    request = urllib.request.Request(
        endpoint(os.environ["CODEX_GATEWAY_SERVICE_URL"]), data=body,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=660) as response:
        result = json.load(response)
    output = result.get("output") if result.get("status") == "ok" else None
    if not isinstance(output, str) or len(output.encode("utf-8")) > 100_000:
        raise ValueError("gateway_result_invalid")
    json.loads(output)  # The caller validates the task-specific schema.
    Path(args.out).write_text(output)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("PhotoStory CodexGateway service call failed.")
        raise SystemExit(1) from None
