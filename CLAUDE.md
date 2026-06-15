# Repository conventions

## Language

**Everything in this repository must be written in English.** This includes:

- Source code, identifiers, and code comments
- Commit messages and pull request titles/descriptions
- Documentation (README, design docs, anything under `docs/`)
- Issue references, TODOs, and any other text committed to the repo

Conversations with the user may happen in any language, but anything that lands
in the repository is English only.

## Secrets & sensitive data

**Never commit secrets or infrastructure details. Anonymize everything.** This
includes:

- Credentials of any kind: passwords, API keys, access/secret keys, tokens.
- Infrastructure specifics: real hostnames, internal URLs, IP addresses, bucket
  names, account IDs, connection strings.
- Any other environment- or customer-specific identifiers.

Use placeholders in committed files (e.g. `<DB_URL>`, `<ACCESS_KEY_ID>`) and keep
real values in untracked `.env` files or the deployment's secret store. Examples
in docs and READMEs must use generic, anonymized values.

## Quality gate before committing

**Tests, linting and formatting must pass before anything is committed.** Run and
confirm all of the following are green first:

- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm run pretty`
- `pnpm test`

Do not commit with failing or skipped checks. If a check cannot pass, fix it (or
raise it with the user) before committing rather than committing anyway.
