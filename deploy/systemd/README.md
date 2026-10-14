# Processor deployment status

The local model subprocess, shared authentication reader, privileged AI-unit launcher and legacy remote HTTP gateway have been removed. The workflow no longer requests model OIDC permissions or reads retired gateway variable names. AI admission stops until a new task backend has been qualified.

This is not a deployment. Existing installations may depend on these paths, so this PR stays draft. The owner must choose and qualify an authenticated task connection and plan the transition. No replacement connection is enabled by this PR.

Preserve inventories, publication records, pending jobs and authentication files. Inspect in-flight work before switching versions. No server was accessed and no service, timer, actual secret or stored variable was changed.
