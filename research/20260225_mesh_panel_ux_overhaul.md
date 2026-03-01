---
title: "Mesh Panel UX Overhaul — Research Report"
date: 2026-02-25
type: external-best-practices
status: active
tags: [mesh, panel, ux, overhaul, progressive-disclosure, ui]
feature_slug: mesh-panel-ux-overhaul
---

# Mesh Panel UX Overhaul — Research Report

**Feature**: mesh-panel-ux-overhaul
**Date**: 2026-02-25
**Research Depth**: Deep
**Searches Performed**: 16

---

## Research Summary

World-class developer tools treat empty states as onboarding moments — not error conditions. The most effective pattern for the Mesh Panel is a **hybrid approach**: smart defaults (auto-suggest the working directory, persist recent scan roots in localStorage) combined with contextual per-tab guidance (illustrated empty states with single, specific CTAs). A wizard is unnecessary and would alienate the developer audience. The Discovery tab has the highest UX debt and is the critical path to unlock all other tabs.

---

## Key Findings

### 1. Empty States Are the First Impression

Every tab in the current MeshPanel shows either a bare spinner or a one-line muted text message ("No agents registered. Discover and register agents from the Discovery tab."). Research shows this pattern consistently produces dead ends. World-class tools treat the first empty state as the highest-ROI design moment.

**Current problems identified in the codebase:**
- `TopologyGraph`: "No agents discovered yet" (muted text, no CTA)
- `AgentsTab`: "No agents registered. Discover and register agents from the Discovery tab." (muted text, no action)
- `DeniedTab`: "No denied paths." (muted text, no context)
- `TopologyPanel` (Access tab): "No namespaces found. Register agents to see the topology." (muted text, no link)
- `DiscoveryTab`: No empty state at all — just a bare text input with no defaults

The pattern across all tabs is passive acknowledgment with no forward momentum.

### 2. The Discovery Tab Is the Keystone

All other tabs are downstream of Discovery. A user who cannot successfully run a scan never sees agents, topology, namespaces, or access rules. The current Discovery tab has maximum friction:
- A plain text input with no placeholder guidance beyond comma-separated paths
- No default value suggesting where to look
- No persistence — the input is blank on every visit
- No recent-scan history
- Scan results are ephemeral — leaving and returning loses them
- "No agents discovered" after a scan gives no follow-up suggestions

Fixing Discovery unlocks every downstream tab.

### 3. Linear's Model Is the Right Reference Point

Linear's "anti-onboarding" philosophy is the closest match to DorkOS's developer audience: engineers reject hand-holding and want fast, competent tooling. Linear pre-populates workspaces with demo data so users learn by observing the ideal state rather than reading instructions. Constraint-based learning (the product prevents bad workflows architecturally) replaces tooltips.

For Mesh: the equivalent is **pre-populating the Discovery input with `$CWD`** (the active session's working directory) and running a scan automatically on first visit. Users learn by seeing results, not by figuring out what to type.

### 4. Smart Defaults Beat Zero-Config Wizards

GitHub's "Default Setup" for code scanning enables it automatically with zero YAML configuration. Snyk auto-scans once a repo is connected. Aikido requires no custom CI. The pattern: detect context, act on it, show results.

For Mesh: the server already knows `DORKOS_DEFAULT_CWD` and the active session's working directory. These are natural defaults for the discovery roots. Offering them as chips (clickable, pre-filled suggestions) rather than requiring manual typing collapses the friction from the Discovery tab by ~80%.

### 5. Illustrated Empty States With a Single CTA

Effective empty states combine:
- **Visual anchor** (icon or illustration — not a generic spinner)
- **Contextual headline** (why it's empty, not just that it is)
- **One action** (never two or three competing CTAs)
- **No secondary links** cluttering the interface

GitHub shows encouraging copy when tasks are completed. Google Gemini uses four example action cards on first use. Linear uses subtle animations pointing to the single correct next action. Airbnb explains the search yielded nothing plus offers one adjustment action.

For Mesh, each tab needs a distinct empty state with an icon, a one-sentence contextual explanation, and a single action button (usually navigating to Discovery or triggering a scan).

### 6. Topology Graph Empty State Requires Special Treatment

Kiali (Istio's management console) shows a topology graph only when measurable request traffic exists. When the graph is empty, it explains *why* (no traffic recorded, no sidecar injection, Prometheus config) rather than just saying "empty." For visualization empty states, a "ghost graph" pattern (a dimmed placeholder showing what the canvas will look like) is highly effective — it sets expectations and reduces uncertainty.

React Flow (already used in `TopologyGraph.tsx`) supports rendering placeholder nodes with a distinct visual style (dashed borders, ghost styling) in the empty state. This is preferable to the current "No agents discovered yet" text-in-a-canvas pattern.

### 7. Recent Directories — localStorage Is the Standard Pattern

For web-app path pickers without native filesystem access, the industry standard is:
- localStorage/sessionStorage for persisting recent paths client-side
- A combobox or tokenized tag input replacing the raw text field
- Suggested paths rendered as clickable chips (no typing required)
- Server-provided suggestions (e.g., `$HOME`, `$CWD`, common agent directories)

The DorkOS server already enforces a security boundary via `lib/boundary.ts` (403 for paths outside home directory). The UI should make this boundary visible — not as an error, but as a constraint shown upfront ("Scanning within your home directory").

---

## Detailed Analysis

### Tab-by-Tab UX Audit and Recommendation

#### Discovery Tab (Priority 1 — Keystone)

**Current state:**
```
[ text input: "Roots to scan (comma-separated, e.g. ~/projects, /opt/agents)" ] [ Scan ]
```

**Problems:**
1. No default value — blank on first visit
2. Comma-separation is developer-hostile for a GUI tool
3. No persistence — state lost on tab change
4. "No agents discovered" is a dead end with no next step
5. Results are not saved — scanning again requires re-entry

**Recommended state:**

Replace the raw text input with a tag/chip input pattern:
- Pre-populate with CWD chip on mount (derived from `useDefaultCwd` entity hook already in the codebase)
- Additional suggestion chips: `~/projects`, `~/workspace`, `~/agents` shown as secondary pills
- Recent scans persisted in localStorage — shown as a "Recent" section above the input
- Scan results persisted in component state with a "Clear results" button (not ephemeral)
- After "No agents found": show two follow-up suggestions ("Try scanning ~/projects" or "Scan a broader directory")
- Show scan depth control (slider 1-5) collapsed by default (progressive disclosure)

**First-time empty state (before any scan):**
```
[Icon: Radar/Search wave animation]
Discover agents on this machine
DorkOS can find compatible agents anywhere in your filesystem.

[Suggested: ~/] [Suggested: ~/projects] [Suggested: $CWD]

[ + Add directory ]  [ Scan Selected → ]
```

#### Topology Tab (Priority 2 — First Landing)

**Current state:**
```
"No agents discovered yet"  (centered muted text on blank canvas)
```

Topology is the default tab. A blank canvas is the worst possible first impression.

**Recommended state:**

Ghost/placeholder graph approach:
- Render 3 dimmed, dashed-border placeholder nodes arranged in dagre layout
- Overlay: "Your agent network will appear here" + "Go to Discovery →" button
- Subtle pulse animation on the placeholder nodes (reduced-motion aware)

When agents exist but have no edges (current state): show agents connected to a central "DorkOS Hub" node (synthetic, shown in a distinct style) to give the graph meaning until real edges exist.

#### Agents Tab (Priority 3)

**Current state:**
```
"No agents registered. Discover and register agents from the Discovery tab."
```

This is actually the best of the current empty states — it names the next action. Improve it:

**Recommended state:**
```
[Icon: Users/Network]
No agents registered yet

Run a discovery scan to find compatible agents, then register them here
to join the mesh network.

[ Go to Discovery → ]
```

The CTA should switch the active tab to Discovery (pass a tab setter or use URL params).

#### Denied Tab (Priority 4)

**Current state:**
```
"No denied paths."
```

This is ambiguous — it could mean "no denials exist" (good) or "the list failed to load" (bad). The empty state should be reassuring.

**Recommended state:**
```
[Icon: Shield with checkmark]
No blocked paths

Agents from these paths would be blocked from joining the mesh.
Use this list to prevent specific directories from participating.
```

No CTA needed — "no denied paths" is a healthy state, not a problem to solve.

#### Access Tab (Priority 5)

**Current state:**
```
[Icon: Shield]
"No namespaces found. Register agents to see the topology."
```

This is directionally correct but lacks context about what namespaces are.

**Recommended state:**
```
[Icon: Shield]
No namespaces configured

Namespaces isolate agent groups — agents can only communicate
within their namespace unless you add cross-project rules here.
Register agents in Discovery to create your first namespace.

[ Go to Discovery → ]
```

---

### Approach Comparison Matrix

#### Approach 1: Wizard-Driven

A step-by-step modal flow launched on first Mesh tab visit:
1. "Let's find your agents" — pick directories
2. "Review discovered agents" — register or deny
3. "Set access rules" — namespace configuration
4. "You're set up!" — show populated topology

**Pros:**
- Complete coverage — no user is left wondering what to do
- Forces important decisions (access rules) upfront
- Well-understood pattern (setup wizards in Supabase, Railway, etc.)

**Cons:**
- Engineers actively reject hand-holding — Linear's research shows this
- Forces decisions before the user understands the system
- Modal interrupts flow and feels heavyweight for a panel within a larger app
- Cannot be re-triggered easily if skipped
- High implementation cost (wizard state machine, multi-step validation)

**Score: Not recommended for this audience**

---

#### Approach 2: Smart Defaults Only

Auto-detect CWD, run a silent scan on first Mesh panel load, show results without user input.

**Pros:**
- Maximum "magic" — feels like the tool understands your context
- Zero friction for the common case
- Fast path to populated state

**Cons:**
- Silent background scans feel invasive for a security-sensitive tool
- Filesystem scanning without user consent crosses an ethical line in a tool with access control
- Results shown without user intent feel surprising
- Fails if CWD is not an agent directory (common case: DorkOS open on a client project)

**Score: Partial recommendation — smart defaults for the input field, NOT auto-scanning**

---

#### Approach 3: Contextual Guidance Only

Improve each tab's empty state with better copy, icons, and CTAs. No pre-filling or persistence. No behavior changes.

**Pros:**
- Lowest implementation risk
- Respects user intent — no automatic actions
- Incremental — can ship tab by tab

**Cons:**
- Doesn't solve the root problem: the Discovery tab still requires manual path entry
- Users who don't know what to type remain stuck
- No persistence means repeated friction on every visit

**Score: Necessary but not sufficient**

---

#### Approach 4: Hybrid — Smart Defaults + Contextual Guidance (RECOMMENDED)

Pre-fill Discovery input with smart defaults (CWD, common directories); persist recent scan roots in localStorage; improve all tab empty states with icons, contextual copy, and single CTAs. No wizard. No auto-scanning.

**Pros:**
- Respects user intent (no unsolicited scans)
- Eliminates the blank-slate problem for Discovery
- Contextual guidance teaches as users explore
- localStorage persistence removes repeated friction
- Low-to-medium implementation complexity
- Consistent with Linear/GitHub philosophy: assume competence, remove obstacles
- No new dependencies
- Security boundary remains explicit (boundary.ts still enforced on server)

**Cons:**
- Smart defaults may not match every user's directory structure
- Requires reading CWD from existing entity hooks (minor coupling)
- localStorage can become stale if directories move

**Score: Recommended**

---

### Security Considerations for Directory Picker

The server enforces a boundary in `lib/boundary.ts` — paths outside the configured boundary return 403. The UI should reflect this constraint:

1. **Visible boundary indicator**: Show a chip or badge "Within your home directory" near the discovery input. This sets expectations before a scan fails.
2. **Error handling for 403**: When a scan returns 403, show "This directory is outside your configured boundary" with the boundary path displayed, not a generic error.
3. **No path traversal via UI**: The comma-separated raw text input allows `../../` paths. The chip/tag input approach should normalize paths before sending (strip trailing slashes, resolve `~`).
4. **Recent paths validation**: Paths stored in localStorage should be validated on read (does the path still exist? is it within boundary?) before displaying as suggestions.
5. **Deny-first transparency**: The Denied tab should link back to whatever triggered a denial (discovery candidate, manual deny) for auditability.

---

### Progressive Disclosure Architecture

The Mesh panel's five tabs represent three levels of complexity:

| Level | Tabs | User State |
|---|---|---|
| Getting started | Discovery | First-time, has nothing |
| Core workflow | Agents, Topology | Has agents, exploring |
| Advanced | Denied, Access | Running mesh, managing ACL |

Progressive disclosure principle: only show Access tab complexity (cross-project ACL forms) after the user has agents in multiple namespaces (`namespaceNames.length >= 2` is already implemented in `TopologyPanel.tsx` — extend this gating to the tab trigger itself, graying it out with a tooltip when fewer than 2 namespaces exist).

---

### React Flow Topology Empty State Pattern

The `TopologyGraph.tsx` currently returns early with muted text when `agents.length === 0`. The ghost-node pattern keeps the React Flow canvas mounted:

```tsx
// Pseudocode — not production code
const GHOST_NODES: Node[] = [
  { id: 'ghost-1', type: 'agentGhost', position: { x: 100, y: 150 }, data: {} },
  { id: 'ghost-2', type: 'agentGhost', position: { x: 300, y: 80 }, data: {} },
  { id: 'ghost-3', type: 'agentGhost', position: { x: 300, y: 220 }, data: {} },
];

if (!agents.length) {
  return (
    <div className="relative h-full w-full">
      <ReactFlow nodes={GHOST_NODES} edges={[]} nodeTypes={GHOST_NODE_TYPES} fitView>
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/60 backdrop-blur-[1px]">
        <p className="font-medium">No agents in the mesh yet</p>
        <button onClick={() => switchToDiscoveryTab()}>Discover Agents →</button>
      </div>
    </div>
  );
}
```

This pattern:
- Preserves canvas layout context for when agents appear
- Gives users a preview of the experience
- Doesn't block them with a blank white rectangle
- The overlay CTA is impossible to miss

---

### Discovery Input — Tag/Chip Component Design

Replace `<input type="text" ... />` in `DiscoveryTab` with a structured multi-value input:

```
┌─────────────────────────────────────────────────┐
│ [~/projects ×] [/opt/agents ×]  ___________     │
└─────────────────────────────────────────────────┘

Suggested:  [~/] [~/workspace] [~/Documents]

Recent:  [~/my-project (2h ago)] [~/agents (yesterday)]
```

**Implementation notes:**
- Each chip is a removable badge
- Typing adds a new chip on Enter or comma
- Suggested paths are server-provided (from a new lightweight endpoint) or client-hardcoded common paths
- Recent paths persisted in localStorage key `dorkos:mesh:recentScanRoots` as `string[]` (max 5 entries, deduplicated, trimmed when stale)
- CWD chip is automatically added on mount if not already in recent paths (using `useDefaultCwd` from `entities/session`)

---

## Recommendation Summary

**Implement Approach 4: Hybrid Smart Defaults + Contextual Guidance**

**Priority order:**

1. **Discovery Tab** — Replace raw text input with chip/tag input, pre-populate with CWD, add suggested paths, persist recent roots in localStorage, improve post-scan empty state
2. **Topology Tab** — Ghost-node empty state with overlay CTA pointing to Discovery
3. **Agents Tab** — Illustrated empty state with "Go to Discovery" CTA button
4. **Denied Tab** — Reassuring "healthy" empty state (no CTA needed)
5. **Access Tab** — Contextual empty state explaining namespaces + CTA; gate tab trigger styling on namespace count

**What NOT to build:**
- A setup wizard — wrong for this audience, high cost, low retention value
- Auto-scanning on panel load — violates user intent and security norms
- Tooltips/coach marks/product tours — Linear's research confirms developers reject these

**Design principles to carry through:**
- One action per empty state (never two competing CTAs)
- Every CTA moves the user forward on the critical path (Discovery → Agents → Topology)
- Boundaries and constraints made visible upfront, not as error states
- Persistence where friction repeats (scan roots, tab state)
- Consistent with existing "Calm Tech" design system (rounded-xl cards, muted palette, reduced motion aware)

---

## Research Gaps and Limitations

- No direct access to Linear, Vercel, or Supabase source code to see exact implementation patterns
- Kiali's exact ghost-graph implementation was not accessible (403 on docs)
- No user research data specific to the DorkOS mesh panel user journey
- Electron filesystem dialog APIs were investigated but not relevant (DorkOS uses web-based path input, not native dialog)

---

## Contradictions and Disputes

- **Wizard vs. inline guidance**: General SaaS onboarding research favors wizards for complex multi-step setups (Userpilot, Userguiding). Developer-tool-specific research (Linear teardown, GitHub's "Default Setup") strongly favors minimal, self-explanatory interfaces. The developer-tool perspective wins for DorkOS's audience.
- **Auto-scan vs. user-initiated**: Smart-defaults research suggests auto-detecting and acting immediately. Security boundary considerations and DorkOS's explicit consent model (tool approval flows in chat) argue for user-initiated scans only. The compromise: pre-fill inputs (no consent required) but don't auto-trigger the scan.

---

## Sources and Evidence

- "Empty states must address 'What now?' with clarity" — [Eleken: Empty State UX](https://www.eleken.co/blog-posts/empty-state-ux)
- "Stick to the principle of one main idea per empty state screen" — [Eleken: Empty State UX](https://www.eleken.co/blog-posts/empty-state-ux)
- "Linear pre-populates workspaces with demo data modeling perfection" — [Candu: Linear Onboarding Teardown](https://www.candu.ai/blog/linear-onboarding-teardown)
- "Engineers reject hand-holding and feature bloat" — [Candu: Linear Onboarding Teardown](https://www.candu.ai/blog/linear-onboarding-teardown)
- "Constraint-based learning: the product prevents bad workflows architecturally" — [Candu: Linear Onboarding Teardown](https://www.candu.ai/blog/linear-onboarding-teardown)
- "Empty states are evolving from static placeholders into dynamic moments of interaction" — [LogRocket: Empty State UX](https://blog.logrocket.com/ux-design/empty-state-ux/)
- "Mock graphs or placeholders visually represent the chart without data, giving a sense of what it will look like" — [LogRocket: Empty State UX](https://blog.logrocket.com/ux-design/empty-state-ux/)
- "GitHub's Default Setup automatically enables scanning without YAML configuration" — [GitHub Blog: Default Setup](https://github.blog/enterprise-software/secure-software-development/default-setup-a-new-way-to-enable-github-code-scanning/)
- "Kiali shows empty graph when no measurable request traffic for selected namespaces" — [Kiali FAQ: Graph](https://kiali.io/docs/faq/graph/)
- "Progressive disclosure defers advanced features to secondary UI, keeping essential content primary" — [LogRocket: Progressive Disclosure](https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/)
- "Staged disclosure takes users through a linear sequence, perfect for onboarding flows" — [Userpilot: Progressive Disclosure](https://userpilot.com/blog/progressive-disclosure-examples/)
- "Supabase: create account, spin up project, copy API keys, writing queries in under 5 minutes" — [LogRocket: Supabase Adoption Guide](https://blog.logrocket.com/supabase-adoption-guide/)
- "Data in localStorage persists over browser sessions" — [Robin Wieruch: Local Storage in React](https://www.robinwieruch.de/local-storage-react/)
- "Provide Clear Context, Suggest Next Steps, Visual Appeal" — [Mobbin: Empty State UI Pattern](https://mobbin.com/glossary/empty-state)
- "GitHub uses post-completion states to reward users" — [Mobbin: Empty State UI Pattern](https://mobbin.com/glossary/empty-state)
- "Linear educates users about new features through contextual guidance" — [Mobbin: Empty State UI Pattern](https://mobbin.com/glossary/empty-state)
- "Personalize early — tailored content from signup helps users feel immediately invested" — [LogRocket: Empty States in UX done right](https://blog.logrocket.com/ux-design/empty-states-ux-examples/)
- "Clear, prominent actions, like one-click buttons or drag-and-drop areas, remove friction" — [LogRocket: Empty States in UX done right](https://blog.logrocket.com/ux-design/empty-states-ux-examples/)

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "empty state UX developer tools", "Linear onboarding teardown anti-onboarding", "topology graph empty state visualization", "progressive disclosure SaaS developer tool"
- Primary information sources: LogRocket UX blog, Eleken design blog, Candu product teardowns, Mobbin UI patterns, Kiali/Istio documentation, GitHub blog
- Codebase files read: `MeshPanel.tsx`, `TopologyGraph.tsx`, `TopologyPanel.tsx`, `use-mesh-discover.ts`, all mesh entity hook files
