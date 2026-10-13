# Council language registry — external databases only

Supabase is the **application database** for sessions, screenshots, solve jobs and
Council reports. The worker MUST NOT read or write language Markdown in Supabase.
Documentation lives either in the source-controlled `docs/language-runtime/*.md`
fallback or in one or more independently provisioned external PostgreSQL
databases exposing an authenticated PostgREST-compatible HTTPS endpoint
(e.g. a Neon Data API). An external Neon database has been provisioned at project
`rough-lake-58845101`, database `language_docs`, with eleven verified
Markdown guides. Supabase holds only the non-secret directory entry.

## Configuration (cloud worker only)

Set `CODE_AUDITOR_LANGUAGE_REGISTRIES` in your server's secure deployment
environment (not in public Next.js variables or a solve job). Example:

```json
[
  {
    "id": "neon-docs",
    "url": "https://YOUR-PRIVATE-DATA-API.neon.tech/",
    "tokenEnv": "NEON_LANGUAGE_DOCS_TOKEN"
  }
]
```

Set `NEON_LANGUAGE_DOCS_TOKEN` as a separate server-only secret. Supabase
service credentials cannot be reused as external language-registry tokens. The endpoint
must be the **data endpoint**, not Neon's management API. The worker never
copies the external token or any Markdown to the client or Supabase.
Only HTTPS, external, non-Supabase endpoints are accepted. Registries are
checked in listed priority order with a 2.5-second timeout each. Each result
requires an approved status, review timestamp, size bound and SHA256 checksum.
A secure worker may discover the Neon endpoint from the service-role-only
`public.external_service_registry` table in Supabase when explicit registry
configuration is absent. This directory is metadata only and is cached for
five minutes. The Neon Data API now allows anonymous `SELECT` on
`public.language_runtime_packs` only, with a row-level-security policy that
admits validated, reviewed documents whose SHA-256 content checksums match.
Anonymous access to proposals and registry peers, and all anonymous writes
to language documents, remain denied. This public documentation path
requires **no Neon Auth token**.

Council Editor workers can discover this endpoint using the private Supabase
service registry, then read the publicly approved Neon guide directly. The
application database does not store a copy of the guide. The previous
`credential_state` field refers to an abandoned service-JWT integration and
is no longer needed for the public-documentation path. No production
worker deployment or live end-to-end HTTP validation is implied by the
GitHub branch commit. On API errors, the bundled Markdown is used.

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
