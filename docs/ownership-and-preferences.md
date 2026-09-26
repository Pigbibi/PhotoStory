# Ownership and curation preferences

PhotoStory is designed for one private editorial workflow per deployment. It is
not a hosted shared service and has no cross-instance account, profile, or
preference store.

## What belongs to an instance

Each Cloudflare Worker and D1 database holds one private set of:

- allowed administrator accounts and connection settings;
- OneDrive source references, drafts, review evidence, and publication records;
- scheduled-production settings and bounded processor state;
- aggregate owner preference signals.

An allowed GitHub account is an administrator of that instance. It is not a
separate tenant. Two administrators of one instance share its drafts and
preferences. Separate people or organizations should use separate deployments,
separate D1 databases, separate OAuth applications, and separate machine tokens.

## What a preference signal records

PhotoStory records two bounded, aggregate signals:

| Owner action | Stored signal | How it is used |
| --- | --- | --- |
| Save a draft after removing one or more carousel photos | A count that the owner prefers a tighter shared visual subject | Future grouping is asked to avoid mixing visually different scenes |
| Approve a strict-AI-reviewed draft when a soft quality item was false | Counts for coherence, composition, or duplicate-frame disagreement | Future strict review can rank otherwise safe quality choices more carefully |

The signals contain no photo pixels, captions, location history, identity data,
or per-photo rejection label. They are bounded counters stored in the deployment's
private D1 state.

## What a preference signal cannot do

Preferences are not model training and are not sent to another PhotoStory
deployment. They cannot:

- make a private, uncertain, or unsafe photo eligible;
- weaken people, location, privacy, approval, or publishing safeguards;
- publish content, approve a draft, or change an existing publication;
- identify a person, infer a private location, or recover a removed photo.

The owner still reviews each draft. Removing a photo is feedback about the
carousel, not a permanent judgement that the photo is unsuitable.

## Operating a shared installation

If several people need independent libraries or independent tastes, run one
instance per person. Adding several names to `ALLOWED_GITHUB_USERS` gives those
people shared administrator access; it does not create separate workspaces.

If you build multi-user support on top of PhotoStory, isolate every record,
preference, OAuth connection, machine token, storage object, and publication
identity by tenant before allowing untrusted users to sign in. That architecture
is outside this repository's current scope.
