---
slug: mcp-server-cards-redesign
id: 260807-140636
created: 2026-08-07
status: specified
design-session: .dork/visual-companion/16893-1786108430
---

# Specification: the MCP server cards

- **Slug:** mcp-server-cards-redesign · **Id:** 260807-140636 · **Linear:** DOR-1005
- **Source:** a live visual-companion design session with the founder (five screens,
  `card-direction` → `attention-stability` → `scope-and-auth` → `final-composite` →
  `final-composite-v2`). Every decision below was picked on one of those screens; the
  later screens override the earlier ones where they differ.
- **The mockups are wireframes.** They fix structure, states, copy, and behaviour. The
  implementation uses the repo's real design system — shadcn primitives, theme tokens,
  `cva` variants, Radix `asChild`, lucide icons. No emoji glyphs, no hex colors, no
  inline styles.

## 1. The problem

The managed-MCP surface in the Agent Hub's Toolkit tab was a one-line row per server.
Six things competed for 340px — dot, status word, name, transport, badge, Manage — so
names truncated to `plugin:cont…`. The words were the system's, not a person's:
"discovered", "stdio", "Validation failed", "brings the server under DorkOS
management". "Connecting…" showed forever for servers nothing had ever checked. And
once a server was signed in, there was no way back in: no Sign in again, no Sign out,
anywhere.

The state logic underneath was correct (DOR-985, DOR-1004 built it carefully) and is
preserved exactly. What changed is everything a person sees.

## 2. Design decisions

Each decision below is one screen of the session: the question asked, the options
shown, what was chosen, and why.

### 2.1 Structure: cards, not a list

**Question.** How much lives on the row versus behind a tap?

**Options.**

- **A — stacked cards.** Two lines per server: name + status, then one plain sentence
  saying what is happening and what to do. The state's single primary action sits on
  the card; everything else behind "⋯". Details expand in place.
- **B — compact list + detail sheet.** One line per server (dot, name, status,
  chevron); tapping opens a `ResponsiveSheet` with the sentence, the actions, and the
  details. Maximum density; every action two taps away.
- **C — attention groups.** Rows grouped by what they need from you: "Needs your
  attention" on top with inline fix buttons, "Working" collapsed, "Found in this
  project" at the bottom. The group header carries the meaning.

**Chosen: A, with C's quality.** A card can say what is happening _and_ what to do
without a second surface, which is what a control panel owes you: the fix is where the
problem is. B hides the one thing a stuck server needs — the button — behind a tap.
C's grouping was wanted for its scannability, but its cost is that cards move; §2.2
buys the scannability without paying it.

### 2.2 Ordering: sort once on open, then freeze

**Question.** How do we get attention-first ordering without a card you are mid-task
on teleporting out from under you?

**Options.**

1. **Sort once when the panel opens, then freeze.** Needs-attention first at mount;
   while the panel stays mounted nothing ever moves. State changes happen in place —
   the chip flips, the sentence updates, the button changes. The new order applies the
   next time the panel opens.
2. **Stable order always, plus a summary line.** Cards keep one permanent order;
   attention is carried by the amber edge, the chip, and a "1 server needs you — jump
   to it" line at the top. Zero movement ever, at the cost of attention items
   sometimes being far down.
3. **Real groups, with the active card pinned.** C's groups stay, but any card with an
   open flow is pinned where it is until you leave; moves happen only when idle, and
   they animate.

**Chosen: 1.** A card a person is mid-sign-in on must never move — that is
non-negotiable, and it is the reason C lost in §2.1. Option 1 gets the scan benefit
exactly once, at the moment it is useful (you open the panel to see what needs you),
and then costs nothing. Option 2 never gives the benefit at all. Option 3 keeps
movement in the system and adds a pin concept a person has to learn.

**Implementation note.** The freeze is explicit, not emergent: a ref captures the sort
order at mount and every later render replays it. Servers that appear later are
appended in arrival order (never inserted), and servers that disappear drop out. A
"stable sort by a memoized comparator" would not do — the comparator's _inputs_ change
as statuses change, and the cards would move.

**Ordering key.** Needs-attention (needs sign-in · can't reach · setup problem) →
working → from-elsewhere (project/plugin/computer) → off.

### 2.3 The label for a server the project brought with it

**Question.** These are servers DorkOS did not add: the project's own config (or a
plugin, or a computer-wide config) declares them, the runtime loads them anyway, and
DorkOS lists them read-only until you adopt one. What do we call that?

**Options.** (a) "From this project" · Manage here. (b) "Came with the project" · Add
to agent. (c) "Already set up in the project" · Take over.

**Chosen: (a) "From this project".** It states a fact about where the server lives
rather than a story about how it got there, and it stays true for the plugin and
computer-wide cases with one word swapped. "Take over" implies a fight; "came with"
implies a bundle that may not exist. The button is **Add to agent** (from b) because
that is what the action does to _your_ agent — "Manage here" describes DorkOS's
bookkeeping, not the person's outcome.

The old confirmation copy ("This brings the … server from this project's config under
DorkOS management") is replaced by: _"granola comes from this project's own config.
Manage it here to enable, disable, or sign in from DorkOS."_

### 2.4 Scope markers: on every card, never status-colored

**Question.** How loud should "where did this server come from" be on a collapsed
card?

**Options.** (A) A quiet glyph before the name with a tooltip. (B) Mark only the
exceptions — servers you added get no marker; least ink. (C) Nothing on the card;
scope lives in the expanded details.

**Chosen: badges on ALL cards** — the ink cost of a fourth badge is trivial next to
the cost of a person having to know that _absence_ means "this agent". B's rule is
learnable but never taught, and a person scanning for "which of these did I add?"
gets no answer from a blank. C makes scope unscannable entirely. A's glyphs were
rejected on execution, not on concept: emoji are banned in this codebase, and four
lucide glyphs at 10px are less legible than four short words.

So: a small neutral badge on every card — `agent` · `project` · `plugin` · `computer`
— never status-colored (color stays reserved for status), each carrying a tooltip
sentence:

| Badge      | Tooltip                                          |
| ---------- | ------------------------------------------------ |
| `agent`    | Added to this agent through DorkOS               |
| `project`  | From this project — declared in its config files |
| `plugin`   | Comes with the _&lt;name&gt;_ plugin             |
| `computer` | From your computer-wide config                   |

### 2.5 A trust panel on the sign-in disclosure

**Question.** The sign-in disclosure is a wall of grey text at the exact moment a
person is deciding whether to hand over an account.

**Chosen.** The disclosure step gets a calm, success-tinted panel (theme status
tokens, never a hardcoded green) with a `ShieldCheck` icon: **"Your sign-in stays on
this computer."** then _"You approve access on &lt;Provider&gt;'s own site. DorkOS
keeps the resulting key here — the agent never sees it, and you can sign out anytime."_
The server-composed disclosure sentence still renders beneath it, verbatim and focused
— the panel adds reassurance, it does not replace consent copy.

### 2.6 Explicit expand/collapse, not a tappable card body

**Question.** How does a person reach the details?

**Chosen.** A visible "Details" affordance with a chevron that rotates when open, and
a "Collapse details" control at the bottom of an open details area. A whole-card tap
target is invisible (nothing says the card is tappable) and it collides with the card's
own controls — switch, buttons, kebab. The explicit control is also the only version
that is reachable by keyboard without inventing a role for the card.

### 2.7 The toggle is always visible, and it IS the off-card's affordance

**Question.** An Off card has nothing to do — its whole state is "turned off".

**Chosen.** The enable `Switch` sits rightmost on line 1 of **every** managed card, at
rest as well as in trouble. An Off card is dimmed with the switch off, and the switch
is how you turn it back on — no "Enable" button that duplicates it, no hunting in the
kebab. Consequence: a person always knows a card can be turned off without opening
anything.

### 2.8 Provenance rows in Details

**Question.** "Where is this server, really?"

**Chosen.** A **Source** row that answers plainly, per shape: a remote server names its
host ("mcp.linear.app — web service"); a plugin server says "Comes with the _X_ plugin"
and shows its raw id; a local one says "Runs `npx shadcn-mcp` on this computer". The
raw id row exists because parsed names are a convenience and a person debugging needs
the string the runtime actually used.

## 3. Card anatomy

Every card — managed or not — is the same three-part shape.

**Line 1.** Name (truncating) · scope badge · status chip (right-aligned) · enable
switch (rightmost; managed cards only).

**Line 2.** ONE plain sentence saying what is happening and what to do.

**Action row.** The state's single primary action (Sign in / Try again / Test / Add to
agent) plus a "⋯" overflow menu. Attention states get a colored left edge — amber for
needs-attention, red for error.

**Details.** A "Details" disclosure under the action row, on every card.

### 3.1 The overflow menu

`Test` · `Sign in again` · `Sign out` · `Remove`. The two sign-in entries appear only
for servers DorkOS holds (or wants to hold) a sign-in for — an OAuth server. See §7 for
why `Sign out` is not shipped in this change.

### 3.2 States, chips, and sentences

Plain language throughout (`writing-for-humans`): no "stdio", no "discovered", no
"Validation failed" on the card face.

| State           | Chip            | Sentence                                                         | Primary action |
| --------------- | --------------- | ---------------------------------------------------------------- | -------------- |
| needs sign-in   | Needs sign-in   | Sign in to _X_ so this agent can use its tools.                  | Sign in        |
| signing in      | Signing in…     | (the trust panel + the disclosure)                               | Open / Cancel  |
| connected       | Connected       | N tools available. / Signed in just now — N tools available.     | —              |
| signed in       | Signed in       | DorkOS has a sign-in for this server. Test to check it responds. | Test           |
| uses your key   | Uses your key   | You added an access key when setting this up.                    | Test           |
| can't reach     | Can't reach     | This server didn't answer. It may be down.                       | Try again      |
| setup problem   | Setup problem   | This server's setup has a problem.                               | Try again      |
| connecting      | Connecting…     | Connecting to this server.                                       | —              |
| not checked yet | Not checked yet | Nothing has checked this server yet.                             | Test           |
| off             | Off             | Turned off — the agent doesn't see this server.                  | —              |

Two rules the old surface broke:

- **"Connecting…" is only ever said when a runtime genuinely reports `pending`.** A
  server nothing has checked reads **Not checked yet** — never a spinner that spins
  forever.
- **The verbatim error string never appears on the card face.** It moves behind
  Details, into an "Error" row, in a monospace font.

### 3.3 Discovered (non-managed) cards

Same anatomy: scope badge, a status chip (live status when the runtime reports one,
otherwise "Not checked yet"), the sentence from §2.3, and **Add to agent** as the
primary action. They carry no switch (there is nothing of ours to turn off) and are
distinguished from managed cards by a subtler surface rather than the mockup's dashed
border.

## 4. Scope derivation and name parsing

| Source                                          | Scope      |
| ----------------------------------------------- | ---------- |
| A managed manifest entry                        | `agent`    |
| A runtime-reported name with a plugin prefix    | `plugin`   |
| A runtime-reported entry scoped project / local | `project`  |
| Anything else runtime-reported                  | `computer` |

The plugin prefix is **parsed, not guessed**: Claude Code's convention is
`plugin:<plugin-name>` (or `<server>@<plugin>` in some builds), and a parsed name shows
clean on the card with the raw id kept for Details. The parser lives in a `lib/` helper
with its own tests, is written as a list of per-runtime conventions, and **falls through
to raw display** whenever nothing matches — an unrecognised name is shown exactly as the
runtime gave it, never mangled. Adding another runtime's convention is adding one entry
to that list.

## 5. Details: render only what exists

Details is a definition grid. Every row is conditional; the layout must read as
complete with only two of them.

| Row          | Content                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in      | "OAuth — signed in _&lt;date&gt;_ · renews automatically. DorkOS holds the key; the agent never sees it." / "Access key — you added a key when setting this up." / "None — this server doesn't need one." / "None yet — not checked." |
| Source       | Remote: "mcp.linear.app — web service". Plugin: "Comes with the _X_ plugin" + a raw-id row. Local: "Runs `<command>` on this computer".                                                                                               |
| Server       | Name / version — **only if present**                                                                                                                                                                                                  |
| Also used by | **only if present**                                                                                                                                                                                                                   |
| Tools        | Count, then tool rows (name + one-line description), first 3 with "Show N more" — **only if present**                                                                                                                                 |
| Error        | Failed servers only: the verbatim string, monospace                                                                                                                                                                                   |

**What exists today:** `authStatus` / `authKind`, `toolCount` (from a poll or a test
result), the connection's url / command / transport, error strings, enabled state.

**What does not exist yet, and is therefore not rendered:** the signed-in date, the
server's own name and version, tool descriptions, MCP-registry matching, and
"also used by". Those need API work and are **DOR-1006**. The rows are written now and
render the moment their data arrives.

## 6. What must not change

The presentation is new; the state machine is not. These survive intact, with their
tests adapted to the new DOM and their assertions' meaning preserved:

- `resolveStatusKey` precedence, all seven rules (DOR-985).
- `offersSignIn` — including "a probe's 401 beats a green cache".
- `liveTestResult` staleness in both directions, **including the same-millisecond
  tie-break toward the listing**.
- The unattended probe on a newly-added remote server, and its `.catch` (DOR-1004).
- The receipt interplay between the listing's `dataUpdatedAt` and a stamped probe.

## 7. Deferred

- **Sign out has no server surface.** `AgentMcpOAuthService.forgetServer` exists and is
  tested, but **no route exposes it** on `main` (checked: `routes/`, the transport
  interface, the `mcp.*` capabilities — the only caller is the removal path inside
  `agent-mcp-server-service`). Inventing server code here would collide with DOR-981,
  which owns `services/mesh/*`. So the overflow menu is built with a `canSignOut`
  capability flag that defaults to `false`, and the entry is hidden. When a route
  lands, the flag flips and the menu item is already wired.
- The Details rows named in §5 as not-yet-available (**DOR-1006**).
- "Sign in again" is `Sign in` re-run against a server that already has a token; it
  ships, since it needs nothing new.

## 8. Verification

- The Dev Playground gains `McpServerCardShowcases` — every state in §3.2 at 340px,
  the real width the sidebar gives these cards, with mock data through the existing
  showcase mock patterns. This is the artifact that keeps the states visible.
- The existing `AgentMcpServers` suite is adapted, not weakened: every assertion keeps
  the thing it proved.
- `apps/e2e/tests/connections/mcp-oauth-signin.spec.ts` and its page object move to
  the new DOM; the row locator, the "Needs sign-in" / "Signed in" / "Connected"
  assertions, and their row-scoping all keep their meaning.
- The load-bearing new behaviours — freeze-on-open, the scope parser's fall-through,
  and details rendering only when data exists — are covered by tests proven to redden
  when the behaviour is reverted.
