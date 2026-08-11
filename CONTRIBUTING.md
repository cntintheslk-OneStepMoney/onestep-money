# Contributing

Thank you for improving OneStep Money.

## Before opening a pull request

```sh
npm ci
npm test
npm run check
npm run lint
```

The correctness-focused lint and privacy checks must pass. Never commit real or realistic personal finance records, bank statements, payslips, credit reports, backups, vault files, access tokens or screenshots containing financial data.

Use clearly fictional values in tests. Keep financial guidance conservative and preserve this safety order:

1. Essential living costs.
2. Payments needed to prevent missed payments or defaults.
3. Contractual minimum payments.
4. A small emergency buffer.
5. Additional debt overpayments.

Unknown or conflicting debt status, required-payment, limit or arrangement information must fail safe. Do not treat a missing field as evidence that an optional payment is appropriate.

Keep the interface ADHD-friendly: one primary action, short labels, visible status and progressive disclosure.

## Git and GitHub conventions

OneStep Money uses a consistent Git and GitHub scheme so release history remains easy to audit.

### Git safety

- Never commit, push, merge or otherwise write directly to `main`.
- Start work from the current `main` on a descriptive non-main branch.
- Never rewrite shared history, force-push, delete remote branches or merge a PR without explicit approval.
- Keep commits focused and avoid unrelated edits.

### Branch names

Use a descriptive branch with no normal release/version number in the branch name, for example:

- `feature/financial-reminders`
- `fix/browser-demo-startup`
- `ui/dashboard-visualisation`
- `chore/repository-conventions`

### Commit titles

Every new non-merge commit uses the same release/type prefix as OneStep Money pull requests:

`[Release][Type] Concise title`

Allowed release prefixes:

- `[vX.Y.Z]` for work assigned to a release.
- `[Unscheduled]` for accepted work without a target release.
- `[Historical]` or `[Superseded]` only when accurately describing historical repository maintenance.

Allowed Types:

- `Feature`
- `Bug`
- `UI/UX`
- `Security`
- `QOL`
- `Maintenance`

Examples:

- `[v2.2.0][Feature] Add local financial reminders`
- `[v2.1.26][Bug] Restore browser demo startup`
- `[Unscheduled][Maintenance] Standardise repository conventions`

Do not use mixed free-form styles such as `Add ...`, `feat:`, `fix:`, `test:` or `chore:` for new commits.

### Commit body

Use a short factual body in this order:

```text
Purpose: Why this commit exists.
Changes: What changed in this commit.
Verification: Tests/checks run, or why verification is unavailable.
Issue: #NN (or N/A only when no Issue exists).
```

The commit body does not replace the full PR description.

### Pull request titles

Normal PRs use:

`[vX.Y.Z][Type] Concise title`

Unscheduled repository work uses:

`[Unscheduled][Type] Concise title`

Historical exceptions may use `[Historical][Maintenance]` or `[Superseded][Type]` when accurate. Do not misrepresent historical delivery.

### Pull request description

Every implementation PR must contain these sections:

1. Purpose
2. Work completed
3. Files changed
4. User-facing changes
5. Technical changes
6. Testing and verification
7. Data and migration impact
8. Known limitations
9. Excluded work
10. Branch details — Branch, Commit SHA, Pull request, Target branch `main`
11. Confirmations

The Confirmations section must state that nothing was committed/pushed directly to `main`, the workflow did not merge the PR, no personal financial data/documents/credentials/secrets/sensitive logs were committed, and only relevant files changed.

### Merge naming

Published history is immutable. Do not rewrite older commit names just to make them match the current convention.

For future merges, preserve the approved PR title as the merge commit title when the GitHub merge UI permits an override, and use the PR summary/body as the merge message. This keeps the top-level `main` history aligned with the same `[Release][Type]` scheme while retaining branch history.

### Historical note

The repository contains earlier free-form and Conventional Commit-style messages. They remain as historical record because renaming them would change published SHAs. The canonical convention above applies from this maintenance change onward.
