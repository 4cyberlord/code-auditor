# Council language registry — external databases only

Supabase is the **application database** for sessions, screenshots, solve jobs and
Council reports. The worker MUST NOT read or write language Markdown in Supabase.
Documentation lives either in the source-controlled `docs/language-runtime/*.md`
fallback or in one or more independently provisioned external PostgreSQL
databases exposing an authenticated PostgREST-compatible HTTPS endpoint
(e.g. a Neon Data API). An external Neon database has been provisioned at project
`rough-lake-58845101`, database `language_docs`, with eleven verified
Markdown guides. Supabase holds only the non-secret directory entry.

## Public documentation read path

Neon Data API for `language_docs` is active at:

`https://ep-flat-forest-akcqqd8f.apirest.c-3.us-west-2.aws.neon.tech/language_docs/rest/v1`

The `anonymous` PostgreSQL role can **only SELECT** approved, reviewed
`language_runtime_packs` whose content hash matches their recorded SHA-256.
It cannot insert/update packs or read proposals and peer registry records.
All 11 stored language guides passed checksum verification and were readable
under the `anonymous` role in the database. Actual unauthenticated HTTPS
requests to the Data API must be checked from the deployed worker environment.

The cloud worker uses its existing Supabase service-role connection to read
the **metadata only** in `public.external_service_registry` (cached five
minutes). It discovers the expected Neon project and HTTPS Data API endpoint,
then fetches one approved language pack at a time without sending a Neon
bearer token. Any failed request uses the bundled Markdown fallback. The
worker does not duplicate language documents in Supabase.

`CODE_AUDITOR_LANGUAGE_REGISTRIES` remains an optional server-only override
for other separately authenticated, PostgREST-compatible language databases.
Private endpoints require a separate `tokenEnv` credential. This is **not
needed** for the public Neon language-docs endpoint.

## External database deployment and publishing

1. Provision a separate Postgres database in Neon or another trusted provider.
2. Apply `deploy/external-language-registry.sql` **there, not Supabase**.
3. Create a dedicated read-only role and RLS policy for the worker's signed
   token. Keep anonymous and authenticated public writes forbidden.
4. To publish from an authorized administrative environment:
   `node scripts/publish-language-packs.mjs --registry=neon-docs --confirm-database-write`.
   That initially stages drafts. After real review, use
   `--approve-reviewed` and `CODE_AUDITOR_DOC_REVIEWER` to publish.
   Set `CODE_AUDITOR_LANGUAGE_PUBLISH_TOKEN` with a separate write-authorized
   external database credential in the administrative environment. The
   publisher rejects the worker's read-only token. Never give publishing
   privileges to the production worker.

The reference-implementation E2B preflight and final-only result gate remain
mandatory. Actual PostgreSQL deployment and E2B testing are separate release
steps. No external DB schema or credentials are deployed by GitHub commits.
