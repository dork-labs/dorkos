---
slug: computer-panel-resources
number: 261014-142234
created: 2026-10-14
status: ideation
design-session: .dork/visual-companion/78105-1791986881
---

# Relevant panel resource tabs and computer PiP

## Intent and assumptions

Follow an agent's computer while talking to it, and keep watching in PiP while switching chats. Replace Pulse/Profile/Chat/Files/Canvas/Browser/Terminal overflow with relevant defaults and a + menu. Human chose alternative A after reviewing three visual alternatives and explicitly requested refinement and implementation.

The single experimental local computer is the shipped contract; expose it only for its bound agent, never infer that every agent has one. Guest/user state stays intact. No paid inference, personal app restart, guest reset, managed-browser programme, Community programme or streaming overhaul.

## Pre-reading and codebase map

- AGENTS.md and meta north-star set: contextual work surfaces, honest claims, isolated writer.
- RightPanelContainer/Header: route and transport predicates, mini-app placements, per-agent layout, Radix keyboard tabs and overflow cues.
- CanvasViews/RoomCanvasBody: server-owned document IDs and active IDs; closing a shared document currently removes it for everyone.
- TerminalPanel: PTYs survive unmount and restore by session/cwd. Its nested strip currently destroys PTYs on tab close.
- ComputerViewer: each mount currently polls independently every 500ms after the frame response and owns a takeover lease and input queue.
- PipHost: one serializable descriptor, floating desktop presenter, phone sheet/mini-bar; survives route changes.

## Directions considered

A: relevant tabs and + menu, concrete resources in one row. B: single view switcher. C: icon rail. Human chose A for implementation. PiP pins a resource rather than following the ambient chat.

## Decisions

Keep Profile and Files as agent defaults; Computer appears only for its bound agent. Pulse and chat details stay available through +. Resource names replace category tabs once a resource exists. Close means close this view; Stop remains explicit. View transfer returns control and requires explicit takeover again. One shared frame loop and input owner cover all presenters. Phone uses existing PiP presentation. Distinct stopped, disconnected and generation-change states prevent stale frames from looking live.
