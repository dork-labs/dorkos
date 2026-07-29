# Implementation Record: User Profile + Onboarding Role Beat

**Created:** 2026-07-29
**Spec:** specs/user-profile-onboarding/02-specification.md (id 260729-084310, DOR-705)
**Program:** Connector Gateway Completion (Slice D; coordinates with `specs/connector-completion`)

## Status

Complete. Shipped in one PR, #608 (`feat(onboarding,profile): DorkBot asks what you do — profile, role beat, and recommendations`), merged to `main` 2026-07-29.

## What shipped

- **`profile` config block** (`packages/shared/src/config-schema.ts`): `roles`, `tools`, `displayName`, `rolePromptDismissedAt`. Classified `expose` + `agent-writable` + `no-risk` in all three drift-guarded tables; no `PROTECTIVE_CARRYOVERS` rule (no leaf has a protective direction). No-op migration anchor composed into the existing `'0.57.0'` key. Docs rows in `contributing/configuration.md` + `docs/getting-started/configuration.mdx`, each stating local-only.
- **`@dorkos/shared/profile-recommendations`**: `ROLE_CANON` (8 roles), `ROLE_ALIASES` (~20), `ROLE_RECOMMENDATIONS` (connector toolkit slugs + marketplace search terms, per spec D5), and the pure, deterministic `recommendForRoles()` (normalize → first-role-first merge → dedupe → cap 3).
- **The role beat**: `BEAT_ORDER` is now arrival → personality → **profile** → discovery → handoff. DorkBot asks what kind of work you do with the privacy line in the same beat; canon chips + "Something else" free text + "Skip this" (skip counts as answered forever). After a save, one authored suggestion line (`dorkbotProfileSuggestionLine`, ≤3 services, never claims anything is configured). `ONBOARDING_STEPS` widened additively.
- **Existing users**: `ProfilePromptCard` in the sidebar — DorkBot-voiced, non-modal, shown at most once ever (five-clause show condition; dismissal persisted on `profile.rolePromptDismissedAt`; never renders alongside `ProgressCard`).
- **ProgressCard**: "Tell DorkBot about your work" row with the shared `ProfileRolePicker` (one picker, three hosts). The "Connect a service" row was deliberately withheld until `specs/connector-completion` shipped the `/connections` route, with a test that goes red if the row lands before the route.
- **Agent context**: pure `buildUserProfileBlock` (`services/runtimes/shared/agent-context.ts`) projects the `<user_profile>` block into every session on all three runtimes via the shared seam, zero adapter changes; best-effort config read never fails a turn.
- **Privacy invariant, pinned by tests**: sentinel-value exclusion on the heartbeat wire body, a `toStrictEqual` exact-shape pin on `buildHeartbeatPayload`, and the usage-event catalog rejecting any `profile` property.

## Review findings and how they were resolved

A deep adversarial review ran pre-PR (verdict approve-with-nits; the PR opened `review:light`); all findings addressed on the branch:

- **Vacuous negative tests fixed and mutation-verified.** The `ProfilePromptCard` harness asserted "does not render" before the config query had settled, so the negative tests passed vacuously. The harness now waits for `queryClient.isFetching() === 0` first. Verified by mutation: removing the `neverAsked` clause turns 2 tests red; gutting the show condition to just the loading checks turns all 6 negative tests red, one per clause.
- **Structural sanitization of profile values.** Profile fields are agent-writable and `config_patch` is reachable from `/mcp`, so `buildUserProfileBlock` strips literal `<user_profile>`/`</user_profile>` tags and collapses newlines; a test feeds a `</user_profile>` breakout payload and asserts the block stays intact.
- **Real-ConfigManager upgrade tests**: a stale pre-profile `config.json` on disk gains the block with defaults; explicit values survive a reload and a second manager over the same file.

## Follow-up

- A Playwright spec driving the role beat and `ProfilePromptCard` in a real browser (filed with the connector-completion follow-ups; the e2e global-setup currently dismisses onboarding on every leg).
