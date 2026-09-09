# Instagram setup

[简体中文](instagram-setup.zh-CN.md)

## Current release

PhotoStory selects, reviews and exports photos, and can connect an Instagram
professional account through OAuth. **Publishing is still not implemented.**
Manual and strict AI approval prepare drafts; neither posts them. Download an
approved draft as a ZIP and upload it with the Instagram app.

Connecting verifies the exact username configured by the administrator, the
professional account type, the app-scoped identity and both required permissions.
Tokens stay encrypted on the server. OAuth failures leave an existing connection
unchanged and are not retried automatically.

## Register a developer account

1. Open [Meta for Developers](https://developers.facebook.com/apps/) and sign in.
2. If prompted, complete developer registration: Continue, account verification,
   contact information, and About you. Enter passwords and verification codes only
   on Meta's official pages.
3. Read and accept the applicable terms yourself. A successful Facebook login does
   not mean developer registration is complete.

## Create your application

This flow was checked in the Meta console on September 10, 2026. Labels and
requirements can change.

1. Select **Create App**. Enter an application name such as `PhotoStory` and your
   own monitored contact email.
2. Under use cases, select **Content management**, then **Manage messaging &
   content on Instagram**. Do not select the generic Facebook Login use case
   merely because you used Facebook to sign in to the developer console.
3. If you have no business portfolio, the console may offer **I don't want to
   connect a business portfolio yet**. This prepares a development app; it is not
   permission to serve arbitrary third-party accounts.
4. Review the requirements and overview. Confirm the name, email and selected use
   case, then accept the terms and select **Create App**. Complete any official
   password/security prompt yourself.
5. In the dashboard, open the Instagram use case and its **API setup with
   Instagram login** section. Check the app's actual access requirements before
   adding an account. Never assume that creating an app or seeing no initial
   requirements means that public access has been approved.

## Configure the Instagram use case

In **Customize → API setup with Instagram login**, Meta creates a separate
Instagram app name (for example, `PhotoStory-IG`), Instagram App ID and Instagram
App Secret. These are distinct from the parent Meta application's credentials;
use these Instagram-specific credentials for the variables below.
Do not reveal or generate a token merely to complete this preparation step.

The setup wizard can offer **Add all required permissions** for messaging, listing
basic profile, comments and messages. A photo publisher should instead open
**Permissions and features** and add only `instagram_business_basic` and
`instagram_business_content_publish`. Leave comments, messages, insights and ads
unselected. An app permission marked ready for testing is not account consent or
approval to serve the public.

Before adding the Instagram account, the console directs you to **App roles →
Roles** to assign its **Instagram Tester** role. Use the intended account's exact
username and follow the invitation acceptance step in Instagram. Meta/Facebook
developer sign-in and Instagram account sign-in are separate sessions.

After adding the username, the Meta roles table shows **Pending** until the
Instagram account accepts. Meta links to [Apps and websites](https://www.instagram.com/accounts/manage_access/)
for invitation management. Sign in as the intended Instagram account, select
**Tester Invites**, and accept the **PhotoStory-IG** invitation. Read the tester
statement and Meta terms before accepting. If opening this link fails at the
login redirect, first sign in at [Instagram home](https://www.instagram.com/),
then reopen Apps and websites. This sequence was verified in the embedded browser.
If login still cannot load, use your normal browser;
do not send passwords or verification codes to the deployment operator. Return
to the Meta roles page afterward and verify that Pending has cleared before
attempting account authorization. Do not remove and re-invite merely because
acceptance is still pending.

The wizard also has a **Webhook callback URL** and a separate **Set up Instagram
business login** section. A webhook callback is not an OAuth redirect URI. Do not
paste an OAuth callback into the webhook field. PhotoStory implements the OAuth
callback below; it does not implement Instagram webhooks.

## Account and permission choices

The integration uses **Instagram API with Instagram Login**, for a
Business or Creator account. Its basic profile permission is
`instagram_business_basic`; content publishing uses
`instagram_business_content_publish`. Do not request messages, comments, ads or
insights permissions solely to publish landscape photos. The similarly named
Facebook Login API has a different setup and must not be mixed into these steps.
See [Meta's official Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

For initial testing, follow the app dashboard's account-role/tester instructions
and accept the invitation from the intended Instagram account. Verify the returned
account identity before enabling any publication. Serving other people's accounts
can require additional access review and business verification; follow the
requirements shown for your app rather than relying on an open-source license.

## Secrets and open-source deployment

Each self-hosted installation should use its own Meta app. MIT licensing does not
share the maintainer's credentials, accounts or approvals. Public examples must
contain placeholders only, without account emails, passwords, access tokens,
client secrets, authorization codes or screenshots containing them.

Store `INSTAGRAM_CLIENT_SECRET` in Cloudflare encrypted Secrets. The Worker stores
the provider token encrypted with the existing `TOKEN_ENCRYPTION_KEY`; do not
rotate that key casually, because it also protects the existing OneDrive token.
Never put credentials in `VITE_*` variables, frontend bundles, browser links,
committed `.env` files or chat messages. Meta's long-lived-token API requires
server-to-server query parameters; these requests never reach the browser and
must not be logged. The Worker disables redirect following and returns fixed,
sanitized errors.

## Configure and connect your deployment

1. Deploy the current code before registering a callback. In your own Worker vars,
   set `INSTAGRAM_CLIENT_ID` to the **Instagram App ID**, `INSTAGRAM_USERNAME` to
   the exact intended username without `@`, and `INSTAGRAM_REDIRECT_URI` to
   `https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/auth/instagram/callback` (or
   the same path on your own HTTPS domain). The public config leaves these empty
   to disable the optional integration. Local HTTP callbacks are not supported.
2. In Cloudflare → your Worker → Settings → Variables and Secrets, add
   `INSTAGRAM_CLIENT_SECRET` as a **Secret**, using the **Instagram App Secret**
   from the Instagram use-case panel. Do not use the parent Meta app's secret.
3. In the Meta Instagram use case → **Set up Instagram business login**, add that
   exact URL as the valid OAuth redirect URI. Check for a trailing slash added by
   the console: the callback must end in `/auth/instagram/callback`, without an
   extra slash. Do not use wildcards and do not fill the Webhook callback field.
4. Sign into PhotoStory with the allowed GitHub owner account. Open **Connection
   Settings → Instagram → Connect Instagram**. Log into the intended Instagram
   account and review the two requested permissions before authorizing.
5. On return, the website shows the verified username and authorization expiry.
   A different username, a personal account, missing permissions, mismatched
   identity, cancelled consent or invalid state prevents connection. OAuth state
   is one-use, expires after ten minutes and is bound to the owner's exact login
   session. Do not sign out of PhotoStory midway through the flow.
6. This release obtains a long-lived token but does not refresh it automatically.
   Use **Reconnect Instagram** before it expires. To revoke access, use Instagram's
   **Apps and websites** settings. The displayed expiry is the stored grant's
   expiry, not a continuous check for revocation; no publishing is enabled.

The implementation follows Meta's [Business Login documentation](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
and [account identity endpoint](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started),
using Graph API `v26.0`. Test the connection with your own app-role account first;
public distribution still depends on Meta's applicable access review.


Keep posting disabled during setup. The first end-to-end test must name the target
account and use one explicitly approved draft. Account authorization, draft
approval and permission to publish are separate steps.

### Runtime troubleshooting

If consent returns but the connection fails, inspect the private, expiring
`instagram-diagnostic` D1 record; never enable raw token-exchange URL logging.
This deployment's Workers runtime rejects `redirect: "error"` before sending the
request. PhotoStory uses `redirect: "manual"` and rejects non-success responses,
including every redirect, so credentials are never forwarded to a redirect target.
