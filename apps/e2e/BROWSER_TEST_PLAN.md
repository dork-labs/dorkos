# Browser Test Plan — Unreleased Changes

Generated: 2026-02-25

## Overview

This plan covers manual and automated browser testing for all unreleased changes. It is organized by priority — critical-path smoke tests first, then feature-by-feature validation.

**Existing coverage:** 4 spec files (app-loads, send-message, session-management, settings-dialog) covering smoke, chat, session list, and settings. No runs recorded yet in the manifest.

**Key gaps:** Pulse, Relay, Mesh, Command Palette, File Browser, Status Bar have zero test coverage.

---

## 1. Smoke Tests (Critical Path)

Validate the app boots and core layout renders after pnpm migration and App.tsx restructuring.

- [ ] App loads at `http://localhost:4241` without console errors
- [ ] Sidebar is visible with session list
- [ ] Chat panel is visible with message input
- [ ] Status bar renders at bottom of screen
- [ ] No broken imports or white-screen crashes
- [ ] Logo/branding renders correctly (DORK monogram, not old triangles)

**Existing spec:** `tests/smoke/app-loads.spec.ts` (3 tests) — run and verify passing.

---

## 2. Pulse Scheduler (Complete Redesign)

The Pulse UI was completely redesigned with new components, cron builder, directory picker, and toast notifications.

### Schedule CRUD
- [ ] Create a new schedule via the Create Schedule dialog
- [ ] Visual cron builder generates valid cron expressions
- [ ] Cron presets (every hour, daily, weekly) populate correctly
- [ ] Timezone combobox filters and selects timezones
- [ ] Directory picker integration works for schedule working directory
- [ ] Edit an existing schedule (fields pre-populate)
- [ ] Delete a schedule (confirmation dialog appears)
- [ ] Schedule list renders with correct status indicators

### Run History
- [ ] Run history panel shows past runs
- [ ] Filtering runs by status works
- [ ] Navigation between schedule list and run history works
- [ ] Active run count badge updates in real-time
- [ ] Cancel a running schedule

### Notifications
- [ ] Toast notifications appear for schedule actions (create, delete, trigger)
- [ ] "Calm tech" favicon-based notifications work when tab is backgrounded

### Accessibility
- [ ] Keyboard navigation through schedule list
- [ ] Screen reader labels on interactive elements
- [ ] Skeleton loading states display during data fetch

---

## 3. Mesh Discovery (New Feature)

Brand new feature: agent discovery, registration, topology graph, health monitoring.

### Agent Discovery & Registration
- [ ] Mesh panel loads and displays status header
- [ ] Discover agents shows candidate cards
- [ ] Register an agent from discovery candidates
- [ ] Register agent dialog validates required fields
- [ ] Deny an agent from discovery candidates
- [ ] Access tab shows denied agents list
- [ ] Unregister (remove) a registered agent

### Topology Graph
- [ ] D3-based topology graph renders registered agents
- [ ] Agent nodes are interactive (click for details)
- [ ] Graph updates when agents are added/removed
- [ ] Graph handles empty state (no agents)

### Health & Observability
- [ ] Agent health detail view shows heartbeat status
- [ ] Mesh stats header shows aggregate counts
- [ ] Health indicators update after heartbeat

---

## 4. Relay Messaging (New Feature)

Brand new feature: inter-agent messaging, delivery tracing, dead-letter handling.

### Messaging
- [ ] Relay panel loads and displays activity feed
- [ ] Send a relay message to a registered endpoint
- [ ] Activity feed updates with new messages
- [ ] Message row shows sender, subject, timestamp
- [ ] Inbox view filters messages for current agent

### Endpoints
- [ ] Endpoint list shows registered endpoints
- [ ] Create a new relay endpoint
- [ ] Delete a relay endpoint

### Delivery Tracking
- [ ] Message trace view shows delivery spans
- [ ] Delivery metrics dashboard renders charts/stats
- [ ] Dead-letter messages appear when delivery fails

### Relay Transport (Chat Integration)
- [ ] When relay is enabled, chat messages route through relay transport
- [ ] `relay_message` SSE events render in chat panel
- [ ] `relay_receipt` confirmation appears after sending
- [ ] Fallback to legacy transport when relay is disabled

---

## 5. Chat (Existing + Relay Changes)

Session routes changed for relay-aware messaging. Verify both legacy and relay paths.

- [ ] Send a message and receive a streaming response
- [ ] Inference indicator shows streaming → complete lifecycle
- [ ] Assistant message renders full markdown after stream ends
- [ ] Tool calls display with expand/collapse cards
- [ ] Tool approval flow works (approve/deny buttons)
- [ ] Message history loads when switching sessions

**Existing spec:** `tests/chat/send-message.spec.ts` (2 tests) — run and verify passing.

---

## 6. Session Management

Session sidebar with relay transport changes.

- [ ] Session list populates on app load
- [ ] Create new session (new chat button)
- [ ] URL updates with `?session=` parameter
- [ ] Switch between sessions (chat panel updates)
- [ ] Session preview text shows in sidebar items
- [ ] Sessions started from CLI appear in list

**Existing spec:** `tests/session-list/session-management.spec.ts` (1 test) — run and verify passing.

---

## 7. Settings Dialog

Verify settings still work after layout changes.

- [ ] Open settings dialog (gear icon or keyboard shortcut)
- [ ] Dialog renders as modal overlay
- [ ] Tab switching works (between settings categories)
- [ ] Close via Escape key
- [ ] Close via click outside dialog
- [ ] Pulse enabled/disabled toggle persists
- [ ] Relay enabled/disabled toggle persists
- [ ] Mesh enabled/disabled toggle persists

**Existing spec:** `tests/settings/settings-dialog.spec.ts` (2 tests) — run and verify passing.

---

## 8. Command Palette (No Coverage)

- [ ] Open command palette (keyboard shortcut)
- [ ] Search filters slash commands
- [ ] Select and execute a command
- [ ] Palette closes after selection
- [ ] Commands from `.claude/commands/` appear in list

---

## 9. Cross-Cutting Concerns

### Navigation & Layout
- [ ] Sidebar collapse/expand toggle works
- [ ] Panel switching between Chat, Pulse, Relay, Mesh
- [ ] URL `?dir=` parameter persists working directory
- [ ] Mobile responsive layout (if applicable)

### Dark Mode / Theming
- [ ] Light mode renders correctly
- [ ] Dark mode renders correctly
- [ ] Theme toggle persists across page reload

### Error States
- [ ] App handles server disconnection gracefully (Express stops)
- [ ] SSE reconnection works after network interruption
- [ ] 409 session lock error displays user-friendly message

---

## 10. Marketing Site (apps/web)

- [ ] Homepage loads with new DORK monogram logo
- [ ] Logo renders at correct size in nav, header, footer
- [ ] Docs pages render at `/docs/*`
- [ ] No broken links after rebrand changes

---

## Execution Plan

### Phase 1: Run Existing Tests
```bash
cd apps/e2e && npx playwright test
```
Verify all 4 existing spec files pass. Fix any regressions before manual testing.

### Phase 2: Manual Smoke Test
Walk through Section 1 checklist in the browser.

### Phase 3: Feature Testing (Sections 2-8)
Work through each feature section. Prioritize by risk:
1. Pulse (complete redesign — highest regression risk)
2. Mesh (new feature — needs full validation)
3. Relay (new feature — needs full validation)
4. Chat + Sessions (existing features with relay transport changes)
5. Settings, Command Palette, Cross-cutting

### Phase 4: Write New Automated Tests
Use `/browsertest create` for high-value test cases discovered during manual testing. Priority candidates:
- Pulse schedule CRUD
- Mesh agent discovery flow
- Relay message send/receive
- Command palette open/search/execute

---

## Progress Summary

| Section | Items | Completed | Status |
|---------|-------|-----------|--------|
| 1. Smoke Tests | 6 | 0 | Not started |
| 2. Pulse Scheduler | 16 | 0 | Not started |
| 3. Mesh Discovery | 11 | 0 | Not started |
| 4. Relay Messaging | 12 | 0 | Not started |
| 5. Chat | 6 | 0 | Not started |
| 6. Session Management | 6 | 0 | Not started |
| 7. Settings Dialog | 8 | 0 | Not started |
| 8. Command Palette | 5 | 0 | Not started |
| 9. Cross-Cutting | 9 | 0 | Not started |
| 10. Marketing Site | 4 | 0 | Not started |
| **Total** | **83** | **0** | **Not started** |
