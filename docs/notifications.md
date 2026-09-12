# Notifications and operator response

PhotoStory currently provides an authenticated, in-site notification for the
owner. The home page checks the saved publication issue when it loads and
refreshes it while the page is open. The project does not send email, browser
push, SMS, or messages to a third-party service.

## Recorded states

Publication failures retain only a fixed stage, timestamp, HTTP status and
numeric provider code. Provider response text, access tokens, authorization
codes and credential-bearing URLs are not shown in the browser. The notice
links to the affected item in the publishing queue.

- **Authorization attention**: reconnect or complete provider verification,
  then use the guarded recovery action when it is offered.
- **Publication attention**: inspect the saved failure stage and exact approved
  draft before changing anything.
- **Uncertain**: Instagram may have accepted the request. Check Instagram and
  the recorded IDs first. Automatic replay is blocked.
- **Storage warning**: review retention and storage usage. Pending review
  photos are not removed by cleanup.

## Operator response

Keep the site open during publishing. If the browser closes after a completed
step, use **Continue publishing**; the server resumes the recorded state
without recreating completed containers. For an account checkpoint, finish
verification on the provider's official site, return to PhotoStory, and use
**Resume after account verification** only when the button is available.

Do not delete a failed or uncertain publication record to force a retry. A
later-stage or uncertain result requires an administrator readback. If the site
is unavailable, inspect deployment logs and the private publication record;
never expose tokens or raw provider responses while diagnosing it.

## Deployment expectation

The VPS maintenance timer must remain online for scheduled scans, token renewal,
temporary-file cleanup and automatic mode. A timer outage is not currently an
offline notification; it must be detected through the deployment's own service
monitoring. The machine-authenticated `GET /internal/health` endpoint is the
sanitized read-only status contract for that monitor. It returns fixed warning
categories, schedule/job/storage state, token expiry metadata and publication
issue state; it never returns folders, captions, photo IDs, provider URLs or
credentials. A monitor should alert on `ok=false` and retain only the category
and timestamp. The endpoint does not publish, refresh credentials, retry jobs or
mutate state.

Before enabling automatic publishing, verify the in-site alert path with an
owner account, confirm that the machine timer is supervised, and test an
uncertain-result response in a non-production environment.
