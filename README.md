# Inkspect API

The self-hosted HTTP service handles dashboard requests and GitHub webhooks. PostgreSQL stores pending work so the metadata, pull request and engine workers can run as separate processes.

## From a pull request to a review

1. The [webhook handler](src/github-webhook.ts) verifies GitHub’s signature. The [event handler](src/pull-request-events.ts) matches the event to a connected repository and records the work in PostgreSQL.
2. The [pull request workflow](src/pull-request-workflow-core.ts) checks the current PR and review settings, submits eligible reviews and publishes results back to GitHub.
3. The engine worker [launches the Rust process](src/engine-process.ts) for each review job. The [Rust engine](https://github.com/inkspect-code-review/inkspect-code-review-engine) runs the model and validates its findings.

Dashboard endpoints are registered in [app-core.ts](src/app-core.ts). The [self-hosted app](src/self-hosted/app.ts) supplies their auth, review and storage implementations.

## Run the API locally

Use Node.js 22.13 or newer and a dedicated PostgreSQL database. Run `npm ci`, then copy `.env.example` to `.env.local`. Set `DATABASE_URL`, the dashboard’s `BETTER_AUTH_URL` and a matching `BETTER_AUTH_SECRET` of at least 32 characters.

```sh
npm run migrate
npm run dev
```

From another terminal, run `curl http://127.0.0.1:3003/health` to check the HTTP process.

For background reviews, configure the GitHub App, Rust binary and model settings in `.env.local`. Build with `npm run build`, then start `npm run metadata`, `npm run pulls` and `npm run engine` in separate processes. Activate the engine using your configured `INKSPECT_GENERATION` in place of `GENERATION`.

```sh
node --env-file=.env.local dist/engine-admin.mjs activate GENERATION http://127.0.0.1:8091
```

## Automatic reviews

Workspace owners and admins configure automatic reviews through `/api/review-settings`.

- `check_threshold` sets the lowest severity that fails a new check (P0–P3, default P0).
- `ignored_authors` skips automatic reviews, replies and fixes for exact GitHub logins.
  Matching is case-insensitive and includes the `[bot]` suffix. Workers cancel pending
  automatic reviews on recheck and revisit known PRs when an author is removed.
  Completed reports and manually requested reviews remain available.

For check re-runs, subscribe the GitHub App to **Check run** events and grant
**Checks: write**. Each re-run creates a separate check and reuses a matching review
or schedules an eligible attempt within the review budget.

[Runtime tests](tests/README.md) · [MIT license](LICENSE) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Support](SUPPORT.md) · [Security](SECURITY.md)
