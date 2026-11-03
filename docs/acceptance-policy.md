# Review policy

Read [AGENTS.md](../AGENTS.md) and the repository engineering conventions first.
This phase-one policy is staged for review. Current native protection, workflows,
approval gates and required contexts remain authoritative. Neither this document
nor the advisory provider configuration supplies an enforcement waiver.

## Pilot boundary

PhotoStory admits only explicitly authorized R0/R1 candidates to the future pilot.
R0 candidates include prose-only photo-workflow documentation and isolated additive tests. Ordinary UI presentation is R1. Token encryption, OneDrive permissions, publication authority and processor isolation are R2.
Do not infer a safe tier from a directory name or apply the pilot to R2 work.
The policy PR itself requires R2 review. No settings, workflows, labels, CODEOWNERS,
merge permissions or runtime behavior are changed by this policy PR.

## Required checks

Current required union of classic protection and active rulesets (preserved):

- `Repository hygiene`
- `risk-gate`
- `pr-template`
- `Gitleaks`
- `checks`

Preserve the union of classic protection and active default-branch rulesets,
including any additional executable/security contexts. Keep existing strictness,
review, conversation, administrator, push, deletion and bypass controls unchanged.
Snapshot exports belong to the job evidence, not this source repository.

Future target, subject to a separately scoped enforcement change:

- `Repository hygiene`
- `risk-gate`
- `Gitleaks`
- `checks`

Only after substantive PR-template evidence and authenticated approval verification
are incorporated into the authoritative `risk-gate` may `pr-template` become
advisory. Do not remove it now. `Evaluate PR governance` is an envelope, and
CodeRabbit is advisory in the target design; this document cannot waive any
currently enforced provider or workflow dependency. Preserve duplicate scanners
until equivalent coverage is separately demonstrated. Required context names and
app bindings must be read back before any future settings migration.

## Shadow observer (installed, non-blocking)

`.github/workflows/review-gate.yml` calls the central reusable workflow
`QuantStrategyLab/.github/.github/workflows/governance-acceptance.yml`, pinned to a
commit, with `mode: SHADOW`.

What is active today:

- Scope: `pull_request` events on this repository. The job reads the pull request,
  its commits and its review state, then reports.
- Output: one check, `review-gate / Governance shadow observation`. It is **not** in
  the required set above and cannot block a merge.
- Side effects: none. It does not label, comment, approve, dismiss, or write to the
  branch. It does not modify protection, rulesets or required contexts.

What is *not* active, and must not be inferred from the check appearing:

- Enforcement. A green observation means the gate ran, not that this repository
  requires it. Adding it to the required contexts is a separate, separately scoped
  change with its own review.
- Replacement of `risk-gate`. The two run independently; `risk-gate` remains the
  authoritative blocking context.
- Any waiver. This observer grants no exemption from the checks listed above.

Rollback is deleting the caller file; nothing else references it.

## Risk tiers and acceptance

Classify the complete diff, including renames, deletions and affected consumers,
against trusted default-branch policy. The author cannot lower a tier with a label
or PR-side configuration. Unknown scope is R2/pending. File extensions alone do
not determine risk; these policy changes themselves are R2.

| Tier | Scope | Required evidence |
| --- | --- | --- |
| R0 | Prose without executable examples or contract changes; bounded skills without authority changes; additive isolated tests without weakened assertions or harness changes | Complete exact diff, shared redaction/secret scan, relevant hygiene/docs/manifest checks, actual execution of added tests, and a small bot-owned exact-head acceptance receipt |
| R1 | Ordinary implementation, refactoring and non-sensitive dependencies/contracts | Relevant unit/integration/type/lint/build checks, affected consumer contracts, secret scan, regression/adverse evidence for changed behavior, and one independent Codex review commissioned by the dedicated bot |
| R2 | Risk/orders/live paths, reconciliation financial semantics, auth/secrets/masking, deploy/IAM, launcher guards, CI/approval policy, CODEOWNERS, authority-changing skills, or tests weakened/deleted in ways that remove safety guarantees | Sol high review, full relevant suites, meaningful adverse cases for applicable redaction/fail-closed/concurrency/stale-state risks, and authenticated current-head owner risk/policy approval |

Required executable checks remain required. Runtime suites may be N/A for R0 only
when trusted complete-diff selection proves them inapplicable; no selector or
exemption is introduced here. Missing, error, transport failure and unknown are
never N/A or PASS. A required test skipped because the PR is Draft is not proof
that it passed. Proven inapplicable Dependabot/release jobs and provider skips are
recorded separately. Known base failures do not silently waive required red checks.
Substantive unresolved findings and valid REQUEST_CHANGES reviews still block;
cosmetic suggestions do not create mandatory repair work.

## Review authority and receipt

The dedicated code-review-and-merge bot is the sole PR review/merge authority.
No ad-hoc second PR reviewer is dispatched. Workers publish Drafts only and never
merge, undraft or label them. R1 independent review and R2 Sol high review are
commissioned within that bot's established process. R0 uses its bounded acceptance
receipt. Reuse a receipt only for the same complete reviewed candidate.

Bind acceptance to repository, PR, full head, base/policy version, tier, authorized
scope, issuer and any expiry/revocation. Head/base/policy drift invalidates the
receipt. Re-read heads and checks before any separately authorized merge. An
`owner-approved` label is a display hint, not an authenticated exact-head receipt.
If original owner evidence cannot be authenticated, retain `owner_needed`.
R0/R1 routine technical acceptance needs no additional owner card within existing
authorization; R2 needs the applicable owner decision. Source approval never grants
deployment, activation, accounts/amounts, seeds, spending or secret access.

CodeRabbit is supplementary. Its quota, availability or green icon supplies neither
primary review nor owner permission. Manual on-demand reviews may include Drafts;
automatic requests, automatic incremental reviews, automatic labels and provider
auto-approval are disabled in the proposed configuration. No `review-ready` label
is applied by this change. Do not widen `max_merge_risk` beyond `low`.

## Model routing

Preserve explicit host model/effort choices and actual availability. Sol medium
remains the default. Record assigned and resolved model; unavailable models or
unsupported efforts stop the affected launch rather than silently falling back.
Model tiers never change authorization or required verification.

| Work | Model / effort | Escalation |
| --- | --- | --- |
| Known-schema readbacks, report formatting, bounded inventory, prose | `gpt-6.1-terra` low | Medium when sources disagree |
| R0 isolated additive tests or small documented patch | Terra medium | Sol medium if behavior, harness or consumer effects emerge |
| Routine backend/API work, ordinary refactoring, R1 review | `gpt-6.1-sol` medium | High for subtle state/concurrency or a failed repair with a concrete unresolved cause |
| Risk, expiry/revocation, transaction safety, masking/secrets, launcher or approval-policy change; R2 review | Sol high | Keep domain adverse tests and owner prerequisites |
| Cross-module architecture or ambiguous subsystem trade-offs | `gpt-6-astra` medium | High only for a named unresolved architecture question |
| Small R0 acceptance, commissioned only by the established bot | Terra low/medium | Sol medium if uncertain; Sol high for protected behavior or authority |

Claude designs/plans/reviews frontend work; Qwen through Qoder implements it.
Codex handles backend/ops/offline work. Cursor stays Auto (`default`), never Fast
or a named model. This policy does not modify launcher arguments, host settings,
repository exclusivity or queue admission, and launches no model trial or paid call.
