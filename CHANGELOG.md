# Changelog

Record every code, fix, documentation, configuration, test and maintenance change
under `Unreleased` with its actual date. Use Added/Changed/Fixed/Removed sections
as appropriate. The package's `0.1.0` version is not a claim of a tagged release.

## Unreleased

### 2026-11-05

#### Added

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
