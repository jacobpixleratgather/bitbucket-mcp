# Changelog

All notable changes to this project are documented here. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-05-01

### Fixed

- `update_pr` no longer wraps the description as `{ raw }`. Bitbucket Cloud's PR PUT endpoint expects `description` as a plain string; the previous nested form caused the literal object to surface in the rendered PR description instead of the user's content.

## [0.1.2] - 2026-04-28

### Added

- `update_pr` tool for editing a pull request's title and/or description (the PR Overview).
- `resolve_pr_comment` tool to mark a comment thread resolved or unresolved.

### Changed

- `list_pr_comments` now reports each comment's resolution state via a `resolved` field.
