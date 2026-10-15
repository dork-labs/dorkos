---
slug: computer-panel-resources
number: 261014-142234
created: 2026-10-14
status: specified
design-session: .dork/visual-companion/78105-1791986881
---

# Relevant panel resources and computer PiP

**Status:** Approved
**Author:** Codex
**Date:** 2026-10-14

## Overview

Show the agent's computer in the right panel or PiP and simplify the panel into one row of relevant views and concrete resources.

## Background and problem

Seven always-visible category tabs overflow the panel, including unused surfaces. Browser and Terminal have a category row and an instance row. The computer currently lives in a Team lifecycle section with an inline viewer, and cannot be followed from the agent's panel or across chats.

## Goals

- Small relevant defaults plus a + menu with every eligible view and resource.
- One header row for document/page/shell resources; preserve standalone previews.
- Agent-bound computer panel tab and pinned desktop/phone PiP.
- Closing/moving a view never stops its computer or task.
- One capture loop per transport/computer generation, exclusive input owner, no automatic takeover.
- Preserve route, transport, mini-app placement, layout, keyboard and mobile contracts.

## Non-goals

No new guest/server lifecycle, multi-computer API, inference spending, personal guest reset, app restart, streaming rewrite or resumed paused programme.

## Technical dependencies

Existing React 19, Zustand, TanStack Query, Radix tabs/menu, FloatingPanel and PiP presenters. No additional dependency.

## Detailed design

The panel first applies existing route/capability/placement predicates. Profile, Files, Room and agent-bound Computer are defaults; Pulse is fallback when no contextual default exists. Optional categories are added explicitly or by existing open commands. A bounded versioned local preference records opened categories and closed views per agent/room. Concrete IDs remain server document IDs and PTY IDs, scoped by session/room. View closure is local and reversible from +.

The container derives document tabs from the shared canvas stores and terminal tabs from the mounted owner's ephemeral projection. The terminal owner remains mounted but hidden within its session/cwd scope after first use; hidden instances cannot focus or send input. Canvas/Browser omit their own tab row under a shared chrome context; standalone previews retain it. The + menu reaches all views including overflow and offers New terminal; destructive PTY shutdown is separately named Stop terminal.

Computer relevance requires the local computer's confirmed cwd to match the selected agent/workspace. A serializable PiP descriptor carries local computer ID, generation, cwd and agent path. PiP never reads ambient chat identity to choose its resource. The panel shows Bring back while PiP owns that computer. Return requests the original agent's computer view; no session or guest is created for navigation.

The computer entity owns a transport-scoped external viewer session. Subscriptions share one loop, framebuffer, lease and ordered input queue. Input is accepted only from the explicitly acquired presenter. Release drops local ownership synchronously before the network request. Disconnect clears the frame; generation mismatch fences old frames/input. Late acquisition after close/transfer is returned. Window blur, visibility loss, presenter unmount and phone minimization release control.

No server API changes. PiP gains the computer descriptor. Panel preferences are a client-local view schema, not persistent server configuration.

## User experience

Open an agent's panel, select Computer, watch or explicitly Take over. Pop out to keep watching while switching chats. Moving the view returns control. Closing PiP keeps the guest/task running. Bring back restores the panel view. Stopped/unavailable states offer reconnect observation, never automatically start a guest. A changed generation requires reconnect in pinned PiP.

Tabs use roving keyboard navigation and Delete to close views. + stays reachable outside the scrolling strip and lists overflow items. Phone retains the existing full-width panel and PiP sheet/mini-bar.

## Testing strategy

Entity tests exercise simultaneous viewers, one capture loop, exclusive input, late acquisition, queue invalidation and generation/disconnect fencing. Panel tests exercise relevance, closed-view restoration, per-context isolation, resource activation and closure without backend destruction. Integration tests cover computer panel/PiP transfer and state handling with mocked transport. Browser proof uses an isolated test app and mocked computer responses, never mutates the personal guest or incurs inference. Geometry and keyboard behavior require the real browser.

## Performance considerations

Keep current 500ms poll cadence; no streaming rewrite. One loop replaces per-presenter loops. Retained shells are limited to the current session/cwd scope and detached on context changes. Preferences cap contexts and IDs.

## Security considerations

Observe sends no input. Takeover remains explicit; a presenter cannot use another presenter's lease. Lease/generation fences remain authoritative server-side. Moving/closing does not stop resources. Cross-chat PiP identity is fixed. No credentials enter view preferences or descriptors.

## Documentation

Capture chosen alternatives and refinements in 04-design-decisions.md. Add a plain-language changelog fragment after verification. Coordinate computer guide owner before any guide edits.

## Implementation phases

1. Shared computer session and panel/PiP presenters.
2. Contextual view preferences, concrete tabs, + menu and feature chrome.
3. Meaningful tests, real-browser proof, current independent review, hooks and protected PR merge.

## Open questions

None. Human selected A and authorized implementation. Multi-computer support follows future server contracts.

## Related ADRs

Existing multi-document canvas, PiP panel, route-aware right panel and agent-computer MVP contracts remain in force. No new server seam or technology is introduced.

## References

DOR-2916. Design session .dork/visual-companion/78105-1791986881. Computer binding and same-generation lease fencing shipped in #2845. Source screenshot: CleanShot 2026-10-14 at 8.59.34 AM@2x.png.
