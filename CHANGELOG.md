# Changelog

This file records the user-facing and release-relevant changes prepared for OneStep Money. Publication and shipped status remain authoritative in the GitHub release/project records.

## 2.2.1 — Interaction Hotfix

### Bug
- Restored core navigation when normal renderer event binding is interrupted (#145).

### Maintenance
- Added runtime-style navigation regression coverage and packaged the independent interaction fallback.
- Updated application package metadata for v2.2.1.

### Data/Migration
- No stored-data format or migration changes.

### Known Limitations
- This hotfix changes interaction reliability only; it adds no new feature scope.

## 2.2.0 — Financial Automation

### Feature
- Added a unified, read-only financial profile for local automation consumers (#82).
- Added the local automation engine and conservative safety framework with duplicate-safe execution, manual-override protection and recovery/revision blocking (#71).
- Added context-aware merchant and transaction-purpose categorisation with ambiguity routed for review (#39).
- Added recurring income and commitment detection (#73).
- Added confidence-based automatic statement reconciliation with ambiguous matches routed to Review Inbox (#83).
- Added payday awareness, income scheduling and Safe Until Payday without treating expected income as received money (#79).
- Added debt recommendation and optional overpayment planning that remains subordinate to Financial Safety (#86).
- Added multi-horizon cash-flow forecasting (#84).
- Added local automation rules, management and safe rule evaluation (#72).
- Added local financial reminders and due-date automation (#75).
- Added automation integration with Review Inbox and Next Move (#77).
- Added automation history, explanations/Why? and guarded safe undo (#78).
- Added non-mutating automation preview, dry-run and Test Rule support (#80).
- Added adaptive payday planning and allocation that protects required commitments, debt obligations and buffers before optional allocations (#85).
- Added the automation dashboard, controls and global pause state (#76).

### UI/UX
- Added user-facing automation management, history, preview, payday, forecast, debt and reconciliation surfaces that consume the existing application theme system.
- Kept ambiguous or safety-sensitive automation decisions visible through Review Inbox rather than silently guessing.

### QOL
- Added bulk payment review and categorisation actions for repetitive review work (#74).
- Added consolidated controls for pausing and inspecting local automation activity.

### Security
- Automation remains local-first and offline-capable; v2.2.0 adds no telemetry, analytics, cloud financial storage or remote financial-processing service.
- Automatic execution is blocked by recovery mode, stale state revisions, manual overrides and unsupported/forbidden action classes.
- Preview/Test Rule remains non-mutating, and safe undo is guarded against overwriting newer manual choices.
- No v2.2.0 automation moves money externally, borrows money or contacts a bank or lender.

### Maintenance
- Aligned package, lockfile, runtime and Windows artifact version metadata for v2.2.0.
- Added the quality benchmark and PR whitespace validation to release CI.
- Expanded the fictional large-dataset quality benchmark to exercise the unified profile, automation evaluation, forecasting, debt recommendations and payday allocation stack.
- Consolidated the v2.2.0 release notes in this changelog (#81).

### Data/Migration
- Automation state remains additive to existing financial state and is covered by the existing state-integrity, persistence, backup/restore and recovery protections.
- Existing supported v2.1.x data is preserved through normalisation/migration paths; financial source records remain authoritative rather than being duplicated into a second automation store.
- All release verification data is fictional/anonymised.

### Known Limitations
- v2.2.0 prepares and applies only approved local state changes; it does not initiate external payments, transfers, borrowing or lender/bank contact.
- Production release publication remains a separate explicit step after review/merge; the tag-only Windows publish workflow is not run by the release-integration PR.
- Automated Electron/package smoke checks complement, but do not replace, interactive human review of the final Windows build.
