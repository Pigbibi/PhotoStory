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
import re
import subprocess
import urllib.parse
import urllib.error
import urllib.request


MAX_REQUEST_BYTES = 15_000_000  # Requires a 16 MB service-side cap for photo batches.
USER_AGENT = "Pigbibi-CodexGateway/1.0"
FAILURE_CATEGORIES = {
    "unknown", "timeout", "transport_error", "setup_required", "invalid_json",
    "gateway_failed", "output_missing", "invalid_input", "input_too_large",
    "invalid_gateway_url", "invalid_oidc_url", "oidc_unavailable", "too_many_images",
    "invalid_input_path", "invalid_image", "gateway_request_too_large", "gateway_result_invalid",
}
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


def main():
    """The legacy HTTP/CLI gateway is retired; never obtain OIDC or send input."""
    raise ValueError("setup_required")


if __name__ == "__main__":
    print('Gateway diagnostic: {"category": "setup_required"}')
    raise SystemExit(1)
