# Changelog

This file records the user-facing and release-relevant changes prepared for OneStep Money. Publication and shipped status remain authoritative in the GitHub release/project records.

## 2.3.0 — Subscriptions

### Feature
- Added a local subscription model that consumes the existing recurring-payment evidence, supports explicit confirm/reject decisions, and allows manual subscription add/edit without introducing a second recurrence engine (#128).
- Added a first-class Subscriptions surface with authoritative normalised monthly/annual costs, filtering, sorting, user ranking and explicit Keep, Essential and Excluded protection states (#129).
- Added provider cancellation guidance that can route to verified direct, help or generic official destinations; Apple-managed subscriptions use the generic Apple subscriptions route, and opening guidance never marks a subscription cancelled (#130).
- Added a local monthly savings target and deterministic lowest-personal-value recommendation that preserves variable cost ranges, reports approximate bottom-X% coverage and remaining gap, and remains advice only (#131).
- Added explicit subscription lifecycle states and integrated unresolved subscription work into the existing Review Inbox and Next Move systems without creating a second task or priority queue (#132).

### UI/UX
- Added keyboard-accessible ranking alternatives, labelled subscription controls, explicit lifecycle controls and non-colour uncertainty/status wording.
- Added clear recurring cost ranges, cancellation/contract review state and savings-target explanation while retaining the existing Light, Night and Follow System presentation foundations.
- Kept cancellation navigation separate from lifecycle state so an external page open cannot imply successful cancellation.

### QOL
- Added local user-owned subscription CSV export with spreadsheet-formula hardening.
- Added conservative savings suggestions that start with the user's lowest-value eligible subscriptions while respecting Keep, Essential, Excluded, contract and lifecycle decisions.

### Security
- Subscription management remains local-first and offline-capable except when the user explicitly opens an official provider cancellation/help page.
- Added no telemetry, analytics, cloud financial storage, remote subscription-management service, provider credential storage or account scraping.
- No v2.3.0 subscription workflow automatically cancels a service, moves money, borrows money or changes a provider account.
- Subscription names, amounts, transaction descriptions, account details, credentials and financial content are not added to logs.

### Maintenance
- Integrated #128 through #132 into one release candidate and expanded fictional regression coverage across recurring detection, ranking, cancellation routing, savings recommendations, lifecycle, Review/Next Move, forecasting, recovery, backup/restore and export.
- Restored the explicit GitHub Pages module allowlist closure required by the subscription Review integration.
- Updated application package and lockfile metadata for v2.3.0 (#133).

### Data/Migration
- Subscription records, savings preferences and lifecycle workflow metadata are additive inert local envelopes inside the existing transactional state container; v2.3.0 does not require a top-level schema bump or historical transaction rewrite.
- Existing state revision, recovery, encrypted restart and backup/restore protections remain authoritative; malformed optional subscription metadata fails conservatively rather than preventing recovery of core financial state.
- Planned or in-progress cancellation does not optimistically remove a recurring commitment from financial forecasts before effective evidence warrants it.
- All release verification data is fictional/anonymised.

### Known Limitations
- Provider cancellation destinations and successful provider-side completion cannot be verified automatically by OneStep Money.
- Cancellation planned/in-progress remains in conservative forecasts until the underlying recurring evidence actually stops or an authoritative effective boundary is available.
- Recommendations are advice only and never execute cancellation or money movement.
- Automatic provider login, cancellation scraping and remote subscription intelligence are not part of v2.3.0.
- Automated Electron/package checks complement but do not replace an interactive human walkthrough of the final Windows build.

## 2.2.4 — Windows Pointer and Fullscreen Rendering

### Bug
- Removed post-v2.1.26 renderer self-observation loops that could repeatedly refresh debt presentation and automation history and starve normal pointer, layout and fullscreen work (#145).
- Restored packaged Windows native mouse interaction across sidebar navigation and ordinary Dashboard controls after delayed startup activity.
- Verified wheel scrolling continues to reach the intended scroll surface while click input remains responsive.
- Restored renderer, hit-test and scroll-surface resizing through maximize, fullscreen and return-to-windowed transitions.

### Maintenance
- Added privacy-safe packaged Windows native-input diagnostics using the real OS cursor/button/wheel path rather than relying only on `webContents.sendInputEvent`.
- Added hit-test, viewport, scrollbar-gutter, fixed-surface and renderer-stability regression coverage for delayed startup and fullscreen transitions.
- Kept the confirmed-working BrowserWindow/GPU configuration unchanged rather than disabling hardware acceleration or forcing content bounds speculatively.
- Updated application package and lockfile metadata for v2.2.4.

### Data/Migration
- No stored-data format or migration changes.

### Known Limitations
- Automated packaged-Windows verification passed, but final physical Windows review by the user remains required before #145 is considered complete.

## 2.2.3 — Delayed Interaction Fix

### Bug
- Removed browser Popover/top-layer notification presentation that could take pointer input shortly after packaged startup (#145).
- Kept navigation and ordinary controls physically clickable after delayed update-status activity.

### Maintenance
- Removed the experimental preload main-world/global DOM prototype patching used by the v2.2.2 workaround.
- Extended Windows Electron interaction verification to re-test real mouse input after a delayed packaged-style update notification.
- Updated application package and lockfile metadata for v2.2.3.

### Data/Migration
- No stored-data format or migration changes.

### Known Limitations
- Automated interaction coverage models delayed update activity and representative controls; final interactive Windows review remains required.

## 2.2.2 — Click Interaction Fix

### Bug
- Kept the notification layer out of Chromium's Popover top layer so it cannot intercept application-wide mouse input (#145).
- Restored reliable physical mouse interaction across sidebar navigation and ordinary Dashboard controls.

### Maintenance
- Added a Windows Electron interaction smoke using real mouse input, scroll-aware sidebar hit-testing and a renderer-bound Dashboard modal action.
- Updated application package and lockfile metadata for v2.2.2.

### Data/Migration
- No stored-data format or migration changes.

### Known Limitations
- Automated interaction coverage validates core navigation and a representative renderer-bound Dashboard control; final interactive Windows review remains required.

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
