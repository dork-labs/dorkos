# Task Breakdown: Slack Adapter for Relay

Generated: 2026-03-13
Source: specs/slack-adapter/02-specification.md
Last Decompose: 2026-03-13

## Overview

Add a built-in Slack adapter to the Relay message bus. The adapter uses `@slack/bolt` in Socket Mode to receive messages from Slack channels and DMs, and uses message posting + updating to stream agent responses token-by-token. Bot responses always thread under the original message. Additionally, a shared `formatForPlatform()` helper is introduced for Markdown-to-platform format conversion.

The implementation follows the same module decomposition as the existing Telegram adapter: `inbound.ts` (parse events), `outbound.ts` (deliver messages), `slack-adapter.ts` (facade), and `index.ts` (barrel).

---

## Phase 1: Foundation

### Task 1.1: Add shared formatForPlatform() utility to payload-utils.ts
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:
- Install `slackify-markdown` to `packages/relay/package.json`
- Add `formatForPlatform(content, platform)` function to `packages/relay/src/lib/payload-utils.ts`
- Supports three platforms: `'slack'` (uses slackify-markdown), `'telegram'` (pass-through), `'plain'` (strip formatting)
- Export from `packages/relay/src/index.ts`

**Implementation Steps**:
1. `cd packages/relay && pnpm add slackify-markdown`
2. Add function to `payload-utils.ts` with platform switch
3. Add export to `packages/relay/src/index.ts`
4. Write tests covering all three platform variants

**Acceptance Criteria**:
- [ ] `slackify-markdown` in package.json
- [ ] `formatForPlatform('**bold**', 'slack')` returns `*bold*`
- [ ] `formatForPlatform('**bold**', 'telegram')` passes through unchanged
- [ ] `formatForPlatform('**bold**', 'plain')` returns `bold`
- [ ] Exported from relay package
- [ ] Tests pass

---

### Task 1.2: Add Slack schemas and type to shared package
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:
- Add `'slack'` to `AdapterTypeSchema` enum in `packages/shared/src/relay-adapter-schemas.ts`
- Define `SlackAdapterConfigSchema` with `botToken`, `appToken`, `signingSecret` (all `.min(1)`)
- Add to `AdapterConfigSchema.config` union
- Re-export `SlackAdapterConfig` type from `packages/relay/src/types.ts` and `packages/relay/src/index.ts`

**Acceptance Criteria**:
- [ ] `AdapterTypeSchema` accepts `'slack'`
- [ ] `SlackAdapterConfigSchema` validates three required string fields
- [ ] Type re-exported from both relay types and index
- [ ] `pnpm typecheck` passes

---

### Task 1.3: Install @slack/bolt dependency
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:
- Add `@slack/bolt` to `packages/relay/package.json`
- Verify `App` and `WebClient` types are importable

**Acceptance Criteria**:
- [ ] `@slack/bolt` in package.json
- [ ] `pnpm install` succeeds
- [ ] `pnpm typecheck` passes

---

## Phase 2: Core Adapter

### Task 2.1: Implement inbound.ts for Slack event parsing
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, 1.3
**Can run parallel with**: Task 2.2

**Technical Requirements**:
- Create `packages/relay/src/adapters/slack/inbound.ts`
- Subject hierarchy: `relay.human.slack.{channelId}` (DMs with D-prefix) and `relay.human.slack.group.{channelId}` (groups with C/G-prefix)
- Echo prevention by comparing `event.user` against cached bot user ID
- Skip non-user message subtypes (`channel_join`, `bot_message`, etc.)
- Build `StandardPayload` with `platformData` including `channelId`, `userId`, `ts`, `threadTs`, `teamId`
- User name resolution via `users.info` with in-memory cache
- Channel name resolution via `conversations.info` with in-memory cache
- Content capped at `MAX_CONTENT_LENGTH` (32KB)
- Constants: `SUBJECT_PREFIX`, `MAX_MESSAGE_LENGTH` (4000), `MAX_CONTENT_LENGTH` (32768)

**Acceptance Criteria**:
- [ ] Correct subject building for DMs vs groups
- [ ] Echo prevention works
- [ ] Message subtype filtering works
- [ ] StandardPayload construction matches spec
- [ ] Caching for user and channel names
- [ ] Error recording without throwing
- [ ] All tests pass

---

### Task 2.2: Implement outbound.ts for Slack message delivery with streaming
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 1.2, 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:
- Create `packages/relay/src/adapters/slack/outbound.ts`
- StreamEvent handling: `text_delta` (post initial message, update subsequent), `done` (finalize), `error` (append error + finalize), silent events (skip)
- Standard payload delivery via `chat.postMessage` with mrkdwn conversion
- All responses threaded under original message (`thread_ts` from `platformData.ts`)
- Echo prevention (skip envelopes from `relay.human.slack.*`)
- Message truncation to `MAX_MESSAGE_LENGTH` (4000 chars)
- `ActiveStream` state map keyed by channel ID
- Uses `formatForPlatform()` for Markdown-to-mrkdwn conversion

**Acceptance Criteria**:
- [ ] Echo prevention works
- [ ] Streaming lifecycle: post -> update -> finalize
- [ ] Error handling with and without active stream
- [ ] Silent events skipped
- [ ] Threading via thread_ts
- [ ] mrkdwn conversion applied
- [ ] Truncation at 4000 chars
- [ ] All tests pass

---

### Task 2.3: Implement slack-adapter.ts facade and barrel exports
**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, 2.2
**Can run parallel with**: None

**Technical Requirements**:
- Create `packages/relay/src/adapters/slack/slack-adapter.ts` extending `BaseRelayAdapter`
- Create `packages/relay/src/adapters/slack/index.ts` barrel
- `SLACK_MANIFEST` with full manifest including configFields, setupSteps, setupInstructions
- `_start()`: Create Bolt App in Socket Mode, cache bot user ID via `auth.test`, register `message` + `app_mention` handlers, call `app.start()`
- `_stop()`: Call `app.stop()`, clear client/botUserId/streamState/caches
- `testConnection()`: Temporary WebClient + `auth.test()`, no Socket Mode
- `deliver()`: Delegate to `deliverMessage()` from outbound module
- Uses `BaseRelayAdapter` for idempotent start/stop, status tracking, error recording

**Acceptance Criteria**:
- [ ] Extends BaseRelayAdapter correctly
- [ ] Socket Mode lifecycle management
- [ ] testConnection validates credentials without side effects
- [ ] Idempotent start/stop
- [ ] SLACK_MANIFEST matches spec
- [ ] Barrel exports SlackAdapter and SLACK_MANIFEST
- [ ] All tests pass

---

## Phase 3: Integration

### Task 3.1: Wire Slack adapter into server integration points
**Size**: Small
**Priority**: High
**Dependencies**: Task 2.3
**Can run parallel with**: None

**Technical Requirements**:
- Export `SlackAdapter`, `SLACK_MANIFEST` from `packages/relay/src/index.ts`
- Add `'slack'` case to `apps/server/src/services/relay/adapter-factory.ts`
- Register `SLACK_MANIFEST` in `apps/server/src/services/relay/adapter-manager.ts` `populateBuiltinManifests()`

**Acceptance Criteria**:
- [ ] SlackAdapter exported from @dorkos/relay
- [ ] Factory creates SlackAdapter for type 'slack'
- [ ] SLACK_MANIFEST registered in adapter manager
- [ ] Slack appears in GET /api/relay/catalog
- [ ] `pnpm typecheck` and `pnpm build` pass

---

## Phase 4: Verification

### Task 4.1: Run full test suite and fix integration issues
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`, `pnpm build`
- Fix type declaration issues (e.g., `slackify-markdown` types)
- Resolve peer dependency warnings from `@slack/bolt`
- Verify no regressions in existing adapter tests

**Acceptance Criteria**:
- [ ] Zero type errors
- [ ] Zero lint errors (or only pre-existing)
- [ ] All tests pass
- [ ] Build succeeds
- [ ] No regressions

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| Phase 1: Foundation | 1.1, 1.2, 1.3 | Dependencies, schemas, shared utilities |
| Phase 2: Core Adapter | 2.1, 2.2, 2.3 | Inbound, outbound, facade |
| Phase 3: Integration | 3.1 | Server wiring |
| Phase 4: Verification | 4.1 | Full test suite validation |

**Total Tasks**: 7
**Parallel Opportunities**: Tasks 1.1/1.2/1.3 can all run in parallel; Tasks 2.1/2.2 can run in parallel
**Critical Path**: 1.2 -> 2.1 -> 2.3 -> 3.1 -> 4.1
