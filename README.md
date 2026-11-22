# inkspect-api

Self-hosted API and shared worker implementation. No payment or Cloud policy code.

## Local development

Requires Node >=22.13. Run `npm ci`, `npm run audit`, `npm test`, and `npm run build`.

This checkout installs independently: internal dependencies are versioned source packages in `vendor/`, with integrity recorded in `package-lock.json`. No sibling checkout, symlink, private registry login or original monorepo is needed. They are generated dependency artifacts; edit each dependency in its own repository and rebuild it with `npm run pack`. Never edit installed package copies.

Internal dependencies: `@inkspect/core`.

Copy `.env.example` to `.env.local`, configure a dedicated database and auth origin, then run `npm run migrate`. Build first, then `npm start`. Workers: `npm run metadata`, `npm run pulls`, `npm run engine`. Engine requires a Rust binary, GitHub App, model/retrieval configuration and activation via `node dist/engine-admin.mjs activate GENERATION http://127.0.0.1:8091`. All listeners default to loopback.

Use the main `inkspect` repository to assemble compatible self-hosted releases. Repository privacy and package publication are controlled separately; all new repositories currently remain private. No production deployment is performed by local build/test commands.

Source code is licensed under [MIT](LICENSE). Third-party dependencies retain their own licenses.

## Ignored pull request authors

Workspace owners and admins can set `check_threshold` to P0 (default), P1, P2 or P3 through `/api/review-settings`. New GitHub checks fail on findings at or above the selected severity.

Workspace owners and admins can manage `ignored_authors` through `/api/review-settings`.
The list defaults to empty and uses exact, case-insensitive GitHub logins, including
the `[bot]` suffix for app accounts. Ignored PRs skip automatic reviews, GitHub
replies and automatic fixes. Existing automatic reviews are cancelled when the
worker rechecks them; completed reports are retained. Removing an author wakes
known PRs again. Reviews and fixes explicitly started in the dashboard remain available.
Apply the API migrations before starting an updated service.

## Contributing and community

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, commit notation and
opening a pull request. All changes need an entry in [CHANGELOG.md](CHANGELOG.md).
Follow our [Code of Conduct](CODE_OF_CONDUCT.md), use [SUPPORT.md](SUPPORT.md)
for help, and report vulnerabilities privately using [SECURITY.md](SECURITY.md).

### GitHub check re-runs

Subscribe the GitHub App to **Check run** events and grant **Checks: write**. Re-run reuses a matching review or schedules another attempt for an eligible pull request. Each re-run creates a separate check. If the next model call would exceed the review budget, the check explains why the review stopped. The check conclusion follows the configured severity threshold and report coverage.
