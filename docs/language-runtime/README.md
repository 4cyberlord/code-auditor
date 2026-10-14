# Language runtime Markdown registry

The Council worker reads a language-specific guide before generating harnesses.
Source-controlled, checksum-verified guides are the reliable offline fallback;
optionally it reads approved Markdown from external PostgREST-compatible
PostgreSQL services configured through `CODE_AUDITOR_LANGUAGE_REGISTRIES`.

**Do not store language documentation in the Supabase application database.**
The external database schema is `deploy/external-language-registry.sql`.
See `docs/council-language-registry.md` for secure configuration and publishing.

- [python](python.md)
- [javascript](javascript.md)
- [typescript](typescript.md)
- [java](java.md)
- [c](c.md)
- [cpp](cpp.md)
- [rust](rust.md)
- [go](go.md)
- [php](php.md)
- [ruby](ruby.md)
- [bash](bash.md)

Documentation guides generation, but executable E2B validation, independent
reference checking and mutation testing remain the correctness authority.
