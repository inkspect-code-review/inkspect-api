# Changelog

Record every code, fix, documentation, configuration, test and maintenance change
under `Unreleased` with its actual date. Use Added/Changed/Fixed/Removed sections
as appropriate. The package's `0.1.0` version is not a claim of a tagged release.

## Unreleased

### 2026-11-22

#### Fixed

- Publish the full finding range on GitHub when its lines are visible in the PR diff.
- Read earlier findings with access to their original commits so verified repairs can resolve the corresponding conversations.

### 2026-11-21

#### Changed

- Expose saved index coverage for visible, connected repositories in the workspace.

- Recognize Bedrock GPT-6.2 Sol Global pricing when measuring review costs.

- Refresh the chat dependency to identify individual findings for issue drafts.
- Refresh the shared chat dependency with text-only input guidance and optional product guides.

#### Fixed

- Preserve finding details when a PR summary cannot be matched to its inline comments.
- Reconcile GitHub check re-runs and completed dashboard reviews against the same pull request and revisions. Link inline findings from the PR summary and keep full details for findings without a comment.

### 2026-11-20

#### Added

- Verify earlier bot findings on subsequent PR reviews and reply with the repair and a source link before resolving the GitHub conversation.

#### Fixed

- Bind fix eligibility and latest-review lookup to the reviewed PR head and target branch. Older reviews without a recorded target require a new review.
- Restore the queue schema fixture used by PostgreSQL metadata and indexing tests.

### 2026-11-19

#### Added

- Allow host applications to supply a review/fix executor and an authenticated loopback model transport without forwarding upstream credentials to the engine. Default and customer-key execution remain unchanged.

### 2026-11-17

#### Fixed

- Report excluded authors, disabled automation, drafts and unscheduled reviews instead of implying that a review will start.

- Allow fixes when only the target branch advances; link changed PR heads to their latest scoped review.

- Disable fix readiness when the reviewed head or target branch differs from the live PR.

- Distinguish closed, draft, changed-commit and changed-target-branch reasons when an auto-fix cannot start.

#### Added

- Allow applications to extend fix request validation and present execution-specific diagnostics without changing default admission rules.

#### Changed

- Upgrade Next.js and eslint-config-next to 16.4.6.
- Refresh shared review history to include stored open finding counts and severity indicators.
- Refresh the shared review-model catalog used by provider validation and credential handling.

### 2026-11-15

#### Changed

- Refresh shared authentication to remember the last completed sign-in method.

### 2026-11-07

#### Added

- Let edition policies run background work within the engine's existing active
  generation, capacity and graceful drain lifecycle. Standby, draining and busy
  workers do not start that work; in-flight operations remain counted until done.

### 2026-11-05

#### Added

- Allow autofix publishers to include a co-author in fix commit messages.
- Allow review policies to explain blocked admissions and waiting jobs in the PR summary and a failed check.
- Save pull request titles with reviews and show queued and paused reviews in GitHub checks.

- Apply a configurable workspace severity threshold to new GitHub review checks, defaulting to P0.

- Publish an Inkspect check for each PR review, showing progress, critical findings and incomplete or failed reviews.
- Workspace PR author exclusions for automatic reviews, replies and fixes, with live rechecks, cancellation and resumption.

#### Fixed

- Link continuing inline findings to their original open discussions from the PR summary across pushes and review reruns.

### 2026-11-04

#### Added

- Route instance AI requests through the Inkspect provider when selected at installation (2026-11-04).

- Initial self-hosted API and shared review workers source snapshot with independent setup and automated checks.
- MIT license, contribution and community guidelines, security/support policies,
  issue forms, a pull-request checklist and dependency-update configuration.
- Pull-request title validation matching the review engine's commit notation.

#### Changed

- Standardized the initial commit subject and future commit/PR titles as
  `type(scope): short imperative description` (maximum 72 characters).
- Included the approved MIT license and contribution documentation in packaged
  source artifacts; removed the provisional license marker.

#### Fixed

- Treat repositories without commits as an empty indexing result; preserve permission failures and allow retry after the first commit.
