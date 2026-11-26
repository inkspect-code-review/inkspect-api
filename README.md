# Inkspect API

The self-hosted API runs database migrations and the metadata, pull request and review workers.

## Local development

1. Use Node.js 22.13 or newer. Run `npm ci` and copy `.env.example` to `.env.local`.
2. Configure a dedicated database and auth origin, then run `npm run migrate`.
3. Run `npm run build` and `npm start`. The API listens on loopback by default.

Run `npm run audit` and `npm test` to check the source. To start a worker, use
`npm run metadata`, `npm run pulls` or `npm run engine`. The engine needs a Rust
binary, GitHub App and model/retrieval configuration. Activate the configured
generation with `node dist/engine-admin.mjs activate GENERATION http://127.0.0.1:8091`.

## Automatic reviews

Workspace owners and admins configure `/api/review-settings`:

- `check_threshold` sets the lowest severity that fails a new check (P0–P3, default P0).
- `ignored_authors` skips automatic reviews, replies and fixes for exact GitHub logins.
  Matching is case-insensitive and includes the `[bot]` suffix. Workers cancel pending
  automatic reviews on recheck and revisit known PRs when an author is removed.
  Completed reports and manually requested reviews remain available.

For check re-runs, subscribe the GitHub App to **Check run** events and grant
**Checks: write**. Each re-run creates a separate check and reuses a matching review
or schedules an eligible attempt within the review budget.

[MIT license](LICENSE) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Support](SUPPORT.md) · [Security](SECURITY.md)
