# Versioned language knowledge and E2B harness reliability

Apply supabase/language-runtime-registry.sql with restricted service credentials; commits alone do not deploy the database. Publish docs via scripts/publish-language-packs.mjs with explicit confirmation and actual reviewer approval. The bundled guides remain available offline. Database guidance requires SHA256, validated status, and review timestamp.

A separately generated REFERENCE implementation can validate a harness in E2B before testing multiple candidates. Reference self-tests require >=2 PASS and zero FAIL. The usual candidate and mutation gates still apply, and lack of a reference never authorizes unchecked code. Stage timing is emitted in event telemetry. The Story Strip remains final-only.

Run the complete repository CI only after integrating every change. A controlled live E2B smoke test and database migration are mandatory before considering the production rollout complete.
