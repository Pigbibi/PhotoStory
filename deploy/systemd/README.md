# Processor deployment status

The local model subprocess, shared authentication reader and privileged AI-unit launcher have been removed. No local CLI fallback is supported. The batch template now uses the remote service transport and refuses missing service configuration.

This change is not a deployment. Existing installations may depend on the removed unit; this PR must stay draft until the owner qualifies an authenticated remote transport and plans the service transition. The GitHub-hosted processor remains the existing service caller; its CI does not prove the service is connected.

Do not delete or reset inventories, publication records, pending jobs or authentication files during migration. Finish or inspect in-flight jobs before switching versions. No server was accessed and no unit, timer, secret or stored variable was changed by this PR.
