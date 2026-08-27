# Development Keys

Use `.development.env` as the local checklist. Do not paste production secrets
into chat or commit real values.

## Apple APNs

Get these from Apple Developer:

- Team ID: Account > Membership details.
- Bundle ID: Certificates, Identifiers & Profiles > Identifiers. Use
  `com.charles.codeeditor` for the iOS companion and enable Push Notifications.
- APNs auth key: Certificates, Identifiers & Profiles > Keys > add key > enable
  Apple Push Notifications service. Download the `.p8` once and copy its Key ID.

Development values:

```bash
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=com.charles.codeeditor
APNS_PRIVATE_KEY_PATH=./AuthKey_XXXXXX.p8
APNS_ENV=sandbox
```

`APNS_PRIVATE_KEY` is still supported for deployment platforms that store
multiline secrets directly. For local development, the path form is easier and
keeps the `.p8` file out of shell history.

## Supabase

In Supabase, open the project dashboard and use the Connect/API settings for:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

The anon key is for desktop/iOS read access with RLS. The service-role key is
server-only and belongs only in the worker environment.

## TokenRouter

Create/copy the gateway API key from the TokenRouter dashboard:

```bash
TOKENROUTER_API_KEY=
```

## Sentry

Create a JavaScript/Node project in Sentry, then copy the DSN from the project
SDK setup page:

```bash
SENTRY_DSN=
SENTRY_ENVIRONMENT=development
SENTRY_TRACES_SAMPLE_RATE=1.0
```

## Telegram

Use BotFather to regenerate the bot token before development testing. Then get
your chat id by messaging the bot and querying Telegram's `getUpdates` endpoint,
or by using a trusted chat-id helper during development.

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## Upstash QStash

In the Upstash Console, open QStash, choose a region and copy:

```bash
QSTASH_TOKEN=
```

Use `CODE_AUDITOR_WORKER_TICK_SECRET` as the bearer token QStash sends to your
worker endpoint.

## cron-job.org

In cron-job.org, create an API key from account/API settings:

```bash
CRON_JOB_ORG_API_KEY=
```

For development, point cron-job.org at your public worker URL, not localhost.
For localhost testing, use QStash dev mode or a tunnel.

## E2B

Create an API key in the E2B dashboard:

```bash
E2B_API_KEY=
CODE_AUDITOR_EXECUTION_PROVIDER=e2b
```

Use E2B only when a job actually needs runnable code validation. MCQ, math and
plain research questions should use Council reasoning and skip benchmarks.

## GitHub Actions

Create a fine-grained token or GitHub App token with Actions write permission for
your repository:

```bash
GH_TOKEN=
GITHUB_REPOSITORY=owner/repo
CODE_AUDITOR_GITHUB_WORKFLOW=cloud-benchmark.yml
CODE_AUDITOR_GITHUB_REF=main
```

The workflow must exist on the default branch before dispatch works.
