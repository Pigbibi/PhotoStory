# AI backend and processor setup

English | [简体中文](ai-setup.zh-CN.md)

PhotoStory separates the website, photo scanner, and AI runtime. The website manages authentication, OAuth tokens, jobs, and human review.

The scanner reads bounded previews from OneDrive, and AI handles only screening, grouping, draft copy, and optional strict review. This public repository provides no accounts, keys, photos, or hosted gateways.

## Active GitHub Actions backends

The active [GitHub Actions processor](github-actions-processor.md) supports two open-source AI configurations without installing CLI wrappers or VPS daemons:

1. **Direct OpenAI or Anthropic API**: Set `OPENAI_API_KEY` (with optional `PHOTOSTORY_OPENAI_MODEL`, defaulting to `gpt-4.1-mini`) or `ANTHROPIC_API_KEY` (with optional `PHOTOSTORY_ANTHROPIC_MODEL`) when `AI_TASK_GATEWAY_URL` and `PHOTOSTORY_NATIVE_BINDING` are unset. Set `PHOTOSTORY_AI_PROVIDER` (`openai` or `anthropic`) if both keys are present.
2. **Generic OIDC Task Gateway**: Set `AI_TASK_GATEWAY_URL` and `PHOTOSTORY_NATIVE_BINDING` (and optional `PHOTOSTORY_SCREEN_BINDING`) to submit bounded tasks authenticated with GitHub OIDC.

Both modes keep credentials isolated from image pixels and prompt inputs. If a call fails, PhotoStory never falls back silently to another paid provider.

## Legacy isolated VPS modes

Older self-hosted Linux deployments can still run the deprecated VPS setup described below:

| Mode | Use case | Requirements |
| --- | --- | --- |
| `codex-cli` | Standalone host with authenticated CLI | Linux VPS, dedicated Linux users, installed CLI binary |
| `aigateway-cli` | Compatible local CLI gateway | Restricted local gateway matching the CLI contract |

Every mode uses only your own accounts and runtime environment. Before enabling any external API, set your own spend caps and review that provider's data retention terms.

## 1. Deploy Worker and OneDrive OAuth

Create the Cloudflare Worker and D1 database per the [README](../README.md), then configure GitHub OAuth, the owner allowlist, and your Microsoft Entra app with these redirects:

```text
https://YOUR-SITE/auth/github/callback
https://YOUR-SITE/auth/microsoft/callback
```

GitHub login requests no repository scope. Microsoft OAuth requests `Files.Read` and `offline_access`; the processor enforces the selected folder and capture-date range.

## 2. Configure processor isolation (VPS)

If using systemd isolation instead of GitHub Actions, follow the [dual-account systemd setup](../deploy/systemd/README.md). Separate Linux accounts ensure the AI runtime cannot read OneDrive tokens, Worker credentials, Instagram credentials, or unrelated directories.

`PHOTOSTORY_STATE_DIR` must be an absolute private path accessible only to the scanner account, outside any Git repository. It holds cursors, source identifiers, version digests, and visual hashes, never original photo bytes or secrets.

## 3. Usage and safety boundaries

AI token cost depends on image count, dimensions, and model choice. Control spend by scanning smaller date ranges, bounding `analysisLimit`, and configuring provider billing limits.

Never treat an uncertain screening outcome as eligible merely to reduce retries or cost. Similarity preselection only filters near-identical bursts using perceptual hashes and color statistics; human review remains the final gate before publication.

See [lifecycle and retention](lifecycle.md), [privacy and operating limits](privacy.md), and [security design](security-design.md) for retention, upgrade, and operational boundaries.
