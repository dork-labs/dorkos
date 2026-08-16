# Design Decisions — profile-unification

Visual companion session: `.dork/visual-companion/7451-1786856918/` (screens `01-profiles-audit-v2.html`, `02-profile-anatomy.html`, `03-simplify.html`, `04-properties-pushin.html`, `05-states.html`; the same dir holds the audit screenshots of today's surfaces). Server was restarted once mid-session (`64508-1786862686/` re-serves `05-states.html`). Two questions were closed in the terminal. Rationale table: `01-ideation.md` §6.

## 1. How many "profile" things exist

**Screen:** `01-profiles-audit-v2.html` — real screenshots of the drawer and the "Agent Profile" tab side by side, the "same agent, two answers" table, the weird/confusing list, and how Slack / Discord / Linear / GitHub / Buzz do it.
**Options:** A) Align & link — keep both, same header, cross-links, rename tab · B) One profile, two homes — one component, docked on `/session`, sheet elsewhere, tabs adapt to relationship · C) Profile page `/team/@handle` + peek drawer + Hub stays.
**Chosen:** **B** — Dorian: "Let's move forward with B. We'll also need to update the hub, and moving forward we shouldn't call it hub anymore." (Clicked B twice in the browser.)

## 2. Header style

**Screen:** `02-profile-anatomy.html` — the same profile drawn with (1) Portrait header (face centered, glow, description, presence, owner, Message/Manage/⋯) and (2) Compact header (face left, chips right).
**Chosen:** **Portrait** — Dorian: "I like the Portrait header." Everything else on that screen (inner tabs Overview · Sessions · Config · Toolkit, section labels, chips + buttons + kebab) was rejected as **"way too busy … we're throwing up everything on the page."**

## 3. Simplification shape

**Screen:** `03-simplify.html` — first a strip of cuts that hold regardless (4 nav systems → 1; chips → one sentence; sessions list → one row; schedule presets → gone; personality pill → behind the face; model/effort controls → one row; section labels → none; kebab → rare only). Then three shapes with the Portrait header: A) Contact card (iOS Contacts: three round actions, plain rows, Manage pushes in) · B) Properties (Linear: header + one button + flat property list; the row is the control) · C) Look / Manage (segmented two-mode panel).
**Chosen:** **B — Properties**, over my recommendation of A. Dorian: "I like B. Also, when I go into some of the items I'd like them to take the full height. For example, when I click into Sessions, it should take pretty much the full height, except for a back link at the top and maybe the small agent avatar/card."

## 4. Push-in pages and the self-edit door

**Screen:** `04-properties-pushin.html` — Root (Portrait + Message + grouped rows), Sessions pushed in (full height; "‹ Profile" + strip; title; search; day groups), Instructions pushed in (full-height SOUL.md editor + Save). Rules: two row kinds (▾ popover, › page) plus ⧉ copy; every pushed page shares the top; groups by spacing not labels; read-only = same list minus arrows; Managed by → pushes the owner's profile; kebab = rare only. Motion: portrait shrinks into the strip, ~250 ms, no celebration.
**Question asked:** with B, your own rows are the controls, so Settings › Profile is a second door — 1) drop it, edit in place · 2) keep both.
**Chosen:** **2 — keep both.** Plus four notes from Dorian, all adopted:

1. Managed by moves into the header, **above** the Message button.
2. **No Message button when you're already messaging that agent** (profile docked in its own session).
3. A person's profile lists **the agents they manage**.
4. "Schedule" isn't a thing — it's **Tasks**.

## 5. States

**Screen:** `05-states.html` — six roots: You · Another person · Someone via Telegram · Your agent · Someone else's agent · DorkBot, with the notes: fixed header order; Message only when it does something; Managed by / Manages are one link drawn both ways; locked ≠ hidden (DorkBot's identity rows show 🔒 + reason); private ≠ locked (someone else's agent shows about / runs on / rooms only); Tasks not Schedule.
**Chosen:** approved — Dorian: "That looks good."
**Two follow-ups closed in the terminal (AskUserQuestion, 2026-08-16):**

- DorkBot's belongs-to line: **"System agent"** (over "Part of DorkOS" and leaving it empty).
- Sessions row on your own profile: **No** — the sidebar owns "my sessions".

## Final Design Summary

There is **one Profile**. It is a single component keyed by the roster member id (`?profile=<id>`), shown **docked** as the right-panel tab **"Profile"** on `/session` (default tab; the same face the sidebar shows) and as a right-side **sheet** everywhere else (full-screen under 768 px). The word "hub" is gone from copy and code; the only verb is **View profile**.

**Header, fixed order:** face (square/circle per identity language, tinted glow behind it) → name with `you` / `default` / `system` badges → `@handle` (tap copies) → one status sentence built from the real live-turn signal ("Replying to you in #team · 2 min" / "Last active 3 h ago" / "Hasn't run yet"; people: "On this machine" / "Last seen 3 h ago" / "On Telegram") → belongs-to line (agent: owner face + "Managed by Dorian", tap pushes the owner's profile; DorkBot: "System agent"; people: none) → **one button, Message** — hidden on your own profile and hidden when the profile is docked in that agent's own session. Kebab top-right holds only Set as default · Copy @handle · Block · Unregister · Delete. Tapping your own agent's face opens the face + personality picker.

**Body:** a flat property list, grouped by spacing, no labels, no tabs. Row kinds: **▾** opens a small popover (Runs on = runtime · model · effort; Personality), **›** pushes a full-height page, **⧉** copies, **🔒** stays visible and explains on tap. If you don't manage the identity, the same rows appear without arrows.

- **You:** Name › · Handle › · Photo › · Email 🔒 ‖ Manages [face stack] N › · Rooms ›. Settings › Profile also stays as a form.
- **Another person:** Role · Manages › · Rooms ›. **Bridged person:** Rooms › · First seen.
- **Your agent:** About › · Runs on ▾ · Personality ▾ · Folder ⧉ ‖ Sessions N · last › · Tasks (N scheduled · next) › · Rooms › ‖ Skills › · Tools & MCP › · Connections › · Instructions (SOUL.md) › · Boundaries (NOPE.md) ›.
- **Someone else's agent:** About · Runs on · Rooms › — nothing private.
- **DorkBot:** About 🔒 · Runs on ▾ · Personality 🔒 ‖ Sessions › · Tasks › · Rooms › ‖ Skills › · Tools & MCP ›; kebab: Set as default only.

**Pushed pages** all share one top: "‹ Profile" + a small strip (face · name · status). Then a title, then the content owns the full height (Sessions: search + day groups, live one first; Tasks: agent-filtered runs + schedules, presets only when empty; Instructions/Boundaries: full-height editor + Save; Manages: agent list where each row pushes that agent's profile; owner: their profile, chained on the same stack). Motion on push: the portrait shrinks into the strip, list slides left, ~250 ms, position-only, back reverses. Sheet entrance stays 300 ms with the static identity rule. Never a celebration on open.
