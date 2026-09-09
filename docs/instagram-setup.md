# Instagram setup

[简体中文](instagram-setup.zh-CN.md)

## Current release

PhotoStory currently selects, reviews and exports photos. **It does not connect to
Instagram or publish posts yet.** Manual and strict AI approval both prepare drafts;
neither mode posts them. Download an approved draft as a ZIP and upload its JPEGs
and caption with the Instagram app.

The steps below prepare your own Meta application. App registration alone does not
connect your Instagram account. Callback configuration, token storage and a live
publishing test will be documented alongside the implementation; do not invent a
callback URL or add unused Instagram secrets to this release.

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
use the credentials named by the Instagram login flow when that integration ships.
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
for invitation management. Sign in as the intended Instagram account and accept
its PhotoStory / PhotoStory-IG tester invitation. If the embedded browser cannot
load Instagram's login page, open that same official link in your normal browser;
do not send passwords or verification codes to the deployment operator. Return
to the Meta roles page afterward and verify that Pending has cleared before
attempting account authorization. Do not remove and re-invite merely because
acceptance is still pending.

The wizard also has a **Webhook callback URL** and a separate **Set up Instagram
business login** section. A webhook callback is not an OAuth redirect URI. Do not
paste an OAuth callback into the webhook field; PhotoStory's current release does
not implement either Instagram endpoint.

## Account and permission choices

The planned integration uses **Instagram API with Instagram Login**, for a
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

When the integration is available, store client secrets in Cloudflare encrypted
Secrets and provider tokens encrypted on the server. Never use `VITE_*` variables,
frontend bundles, URLs, committed `.env` files or chat messages for credentials.
Configure the exact HTTPS callback provided by that release; avoid wildcard
callbacks. A callback must validate a one-time, expiring state bound to the owner
session before exchanging an authorization code.

Keep posting disabled during setup. The first end-to-end test must name the target
account and use one explicitly approved draft. Account authorization, draft
approval and permission to publish are separate steps.
