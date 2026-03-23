# Task Breakdown: World-Class Slack Adapter Improvements

Generated: 2026-03-23
Source: specs/slack-adapter-world-class/02-specification.md
Last Decompose: 2026-03-23

## Overview

Implement 8 targeted improvements to the Slack adapter: event dedup, auth failure handling, typing indicator default, thread-aware respond mode, DM access control, shared message splitting, thread-first enforcement, and channel overrides.

## Phase 1: Foundation

### Task 1.1: Extract shared splitMessage() to payload-utils.ts

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:

- Move `splitMessage()` from `packages/relay/src/adapters/telegram/outbound.ts` to `packages/relay/src/lib/payload-utils.ts`
- Enhance with multi-priority split points (paragraph > line > word > hard cut)
- Add code-block fence awareness (close/reopen ``` at split boundaries)
- Export `TELEGRAM_MAX_LENGTH` (4000) and `SLACK_MAX_LENGTH` (3500) constants
- Refactor Telegram adapter to import from shared location

**Acceptance Criteria**:

- [ ] `splitMessage()` exported from payload-utils.ts
- [ ] Telegram adapter imports from shared location
- [ ] All existing Telegram tests pass
- [ ] New splitMessage tests pass (9 test cases)

### Task 1.2: Create ThreadParticipationTracker

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:

- Create `packages/relay/src/adapters/slack/thread-tracker.ts`
- Instance-scoped class (NOT module-level) for multi-instance safety
- LRU Map keyed by `${channelId}:${threadTs}`, max 1000 entries, 24h TTL

**Acceptance Criteria**:

- [ ] Class is instance-scoped
- [ ] LRU eviction works
- [ ] TTL expiration works
- [ ] All tests pass (7 test cases)

### Task 1.3: Add new config fields to SlackAdapterConfigSchema

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:

- Change `typingIndicator` default: `'none'` -> `'reaction'`
- Add `respondMode`, `dmPolicy`, `dmAllowlist`, `channelOverrides` fields
- All new fields have backward-compatible defaults

**Acceptance Criteria**:

- [ ] Schema parses with no config (defaults apply)
- [ ] Backward compatible with existing configs
- [ ] `pnpm typecheck` passes

## Phase 2: Core Features

### Task 2.1: Add event deduplication to inbound handler

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Add `event_id` LRU Set (500 entries, 5min TTL) to `handleInboundMessage()`
- Add `InboundOptions` interface for new parameters
- Pass `body.event_id` from `slack-adapter.ts` handlers
- Add to `clearCaches()`

**Acceptance Criteria**:

- [ ] Duplicate events silently skipped
- [ ] Cache bounded at 500 entries
- [ ] TTL works correctly
- [ ] All tests pass

### Task 2.2: Add graceful auth failure handling

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Add `FATAL_SLACK_ERRORS` Set in `slack-adapter.ts`
- Update `app.error()` handler to stop adapter on fatal errors
- Descriptive error message surfaces in Relay panel

**Acceptance Criteria**:

- [ ] Fatal auth errors stop adapter immediately
- [ ] Non-fatal errors continue normal behavior
- [ ] All tests pass

### Task 2.3: Add respond mode gating and DM access control

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.2, 1.3, 2.1

**Technical Requirements**:

- Implement respond mode gating (always, mention-only, thread-aware)
- Implement DM policy check (open, allowlist)
- Implement channel override logic
- Export `getEffectiveChannelConfig()` utility
- Wire ThreadParticipationTracker from slack-adapter.ts

**Acceptance Criteria**:

- [ ] All respond mode variants work correctly
- [ ] DM policy gating works
- [ ] Channel overrides work
- [ ] All state instance-scoped
- [ ] All tests pass (13+ test cases)

## Phase 3: Integration

### Task 3.1: Replace Slack truncation with message splitting

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 3.2, 3.3

**Technical Requirements**:

- Replace `truncateText()` with `splitMessage(SLACK_MAX_LENGTH)` in outbound.ts
- Post multiple messages with 1.1s delay between chunks
- All chunks to same thread

**Acceptance Criteria**:

- [ ] No more silent truncation
- [ ] Messages split at natural boundaries
- [ ] Rate limiting between chunks
- [ ] All tests pass

### Task 3.2: Enforce thread-first responses and track participation

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, 2.3
**Can run parallel with**: Task 3.1, 3.3

**Technical Requirements**:

- Add safety warning for channel messages without threadTs
- Verify all outbound code paths (standard, stream, approval) use thread_ts
- Mark thread participation after every successful outbound post
- Clear tracker on adapter stop

**Acceptance Criteria**:

- [ ] All channel messages use thread_ts
- [ ] Warning logged for missing thread_ts
- [ ] Participation tracked on all outbound paths
- [ ] All tests pass

### Task 3.3: Update SLACK_MANIFEST configFields for new settings

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: Task 3.1, 3.2

**Technical Requirements**:

- Add respondMode, dmPolicy, dmAllowlist, channelOverrides to configFields
- Group in 'Access Control' section
- Use radio-cards display for respondMode and dmPolicy
- showWhen for dmAllowlist

**Acceptance Criteria**:

- [ ] All new fields in manifest
- [ ] Fields grouped correctly
- [ ] Conditional visibility works
- [ ] All tests pass

## Phase 4: Testing & Documentation

### Task 4.1: Comprehensive test coverage and documentation

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.3, 3.1, 3.2, 3.3

**Technical Requirements**:

- Run full test suite across all affected packages
- Verify Telegram adapter still works after splitMessage refactor
- Run typecheck and lint
- Update contributing/relay-adapters.md with new config fields
- Update docs/relay-messaging.mdx if applicable

**Acceptance Criteria**:

- [ ] All tests pass
- [ ] No lint errors
- [ ] No type errors
- [ ] Documentation updated
- [ ] No regressions
