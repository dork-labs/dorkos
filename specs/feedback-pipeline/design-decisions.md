# Feedback pipeline — design decisions

Design checkpoint held with Dorian via the visual-companion skill. This doc is
the durable record of what was decided and why. It feeds the UI implementation
PRs (**PR C** — dialog + entry points + GitHub demotion; **PR D** — the tracking
view).

> **⚠️ The files in `mockups/` are WIREFRAMES, not final designs.** They convey
> layout, hierarchy, states, and copy intent using grey boxes and emoji. They are
> NOT the target visual design and must not be pixel-copied. Build them properly
> with the real design system: shadcn/ui + Tailwind v4 tokens, Calm Tech spacing
> and radii (`.claude/rules/components.md`, `contributing/design-system.md`),
> lucide icons (not emoji), theme tokens so dark mode works, and
> `focus-visible` styles on every interactive element. Match how the app actually
> looks — the wireframes only tell you what goes where and what it says.

Mockup files (`specs/feedback-pipeline/mockups/`):

- `01-help-menu.html` — help-menu reorganization (baseline vs. chosen)
- `02-dialog.html` — the revamped dialog, attachments panel expanded (chosen layout)
- `03-dialog-states.html` — anonymous mode + drag-over states
- `04-feedback-and-requests.html` — the tracking view

---

## 1. Help menu — GitHub demoted (chosen: **Option A, flat**)

**Screen:** `mockups/01-help-menu.html`

The help menu keeps two primary in-app actions and demotes GitHub to a single
muted secondary line:

- **Send feedback** (primary) — opens the dialog, kind defaults to Feedback.
- **Report a bug** (primary) — opens the same dialog, kind preset to Bug.
- _(separator)_
- **Report on GitHub…** (muted, secondary) — opens a small chooser (bug vs.
  feature) that falls through to the existing `buildIssueUrl` GitHub path.
- **Documentation** (muted).

Rejected: Option B (GitHub behind a "More ▸" submenu) — stronger demotion than
needed and adds a hover/click hop for no real benefit.

**GitHub is removed from the command palette entirely** (not merely
deprioritized) per the standing instruction. `useReportIssue` / `buildIssueUrl` /
`sanitizeFlags` stay in the codebase (the CLI `dorkos feedback` command still uses
them); only the palette contribution and the help-menu prominence change. The
palette instead gets an **Open feedback** entry.

---

## 2. The dialog — message-first, collapsible (chosen: **Option B**)

**Screens:** `mockups/02-dialog.html`, `mockups/03-dialog-states.html`

Rejected: Option A (everything inline) — too tall and busy for the Feedback/Idea
cases, which don't need diagnostics/transcript.

### Structure (top to bottom)

1. **Kind selector** — Feedback / Bug / Idea (unchanged from today).
2. **Message** textarea — placeholder varies by kind (unchanged).
3. **Identity line** — `Sending as <email>` with a `Send anonymously` toggle
   (see §3). Only shown when `useCurrentUser()` resolves a signed-in user.
4. **"Attachments & details"** — a single collapsible row. Collapsed by default
   for a clean first impression; its trigger shows state at a glance (e.g.
   "Diagnostics on · 0 files"). Expanded, it contains, in this order:
   - **Screenshot area FIRST** — a drag/paste/browse drop zone, then a row of
     capture affordances: `◎ Capture screen` and `⊹ Point at element` (the latter
     labeled "soon" — see §4).
   - **Two toggles side by side** — `🩺 Diagnostics` and `💬 Conversation`, each
     an icon + checkbox, **both checked by default (for the Bug kind)**, each
     **collapsed** with a `▾` that expands to a short summary containing a
     **"View full preview →"** link (§5).
   - **Privacy line** — `🔒 Private — only the DorkOS core team sees these. Never
public.`
5. **Contact** field — "Email or handle, if you'd like a reply" (unchanged).
6. **Send** button.

### Per-kind defaults

- **Bug:** Diagnostics ON, Conversation ON (when a session is in context).
- **Feedback / Idea:** Diagnostics OFF, Conversation absent — these usually have
  nothing to diagnose. The user can still open the panel and turn diagnostics on.
- **Conversation toggle only appears when a session id is resolvable** from the
  current route (`/session?session=…`). Off other routes there is no conversation
  to attach, so the toggle is absent (not shown-but-disabled).

### Icons (use lucide, not emoji)

Diagnostics and Conversation need real lucide icons chosen at build time
(candidates: `Activity`/`Stethoscope`/`Gauge` for diagnostics, `MessageSquare`
for conversation). The 🩺/💬 in the wireframe are placeholders.

---

## 3. "Send anonymously" — a real toggle, with an honest note

**Screen:** `mockups/03-dialog-states.html` (bottom-left)

- Default (signed in): `👤 Sending as <email> · Send anonymously`.
- After clicking: `🕶 Sending anonymously · Use my account` — the right-hand link
  is the way back; clicking it re-attaches identity. It is a two-way toggle, not a
  one-way action.
- **It does something real:** anonymous mode sets an explicit flag so the server
  does NOT attach `reporterEmail`/`reporterName` to the report. (This is the
  `anonymous: true` path — option (b) in spec Part 1, chosen over display-only
  suppression, because the user expects it to actually withhold identity.)
- **Honest note shown in anonymous mode:** "Your report won't include your name or
  email. You can still track it in this app; add a contact below if you'd like a
  reply." The install's private `instanceId` still rides along (so the submission
  appears in the user's own Feedback & requests view), but the team never sees who
  sent it.

---

## 4. Screenshots — three tiers, build 1+2 now

**Screen:** `mockups/02-dialog.html` (capture row)

1. **Paste / drag / browse** (build now) — ⌘V a screenshot, drag a file onto the
   dialog, or click to pick. Client-side downscale/compress (WebP, cap ~2000px)
   before upload via the existing upload path (`transport/upload-methods.ts`); do
   NOT base64 into the JSON submission.
2. **"Capture screen"** (build now) — one click grabs the current cockpit. On web,
   a DOM-to-image render of the app root (silent, sees only DorkOS, never the rest
   of the desktop — the privacy-correct default; avoid `getDisplayMedia`, which
   prompts and captures the whole screen). On Electron, `webContents.capturePage()`
   is pixel-perfect and silent.
3. **"Point at element"** (deferred, labeled "soon" in the UI) — the Vercel-style
   crosshair: click the broken element, capture a cropped shot plus the component
   identity (readable from the shadcn `data-slot` attributes / React fiber). A
   bigger build; sequenced as the fast-follow, reusing the same attachment
   pipeline. Ship the "soon" affordance disabled/greyed so the roadmap is visible.

### Drag-over indicator

**Screen:** `mockups/03-dialog-states.html` (bottom-right). When a file is dragged
anywhere over the dialog, the whole dialog becomes a highlighted drop target
(accent dashed border + `⬇ Drop image to attach`). This is part of tier 1.

---

## 5. Full preview of what's sent

**Screen:** `mockups/04-…` shows the tracking view; the preview surface is
described in `02-dialog.html`'s expanded toggles ("View full preview →").

Both Diagnostics and Conversation are fully previewable before send — a tabbed,
scrollable surface showing **exactly** what will be transmitted:

- **Diagnostics tab:** the real assembled bundle — version, platform, runtime,
  route, on/off flags, breadcrumbs (recent console/query/SSE events), and the
  scrubbed server-log excerpt — with the scrubbing stated inline ("home paths
  shown as ~, tokens removed").
- **Conversation tab:** the actual transcript excerpt that will be attached (§ the
  ~10-turn default below), tool output trimmed.
- The privacy line repeats at the foot of the preview.

This is the mechanism that keeps "pressing Send is the consent" honest: the user
can see the full payload, not just a checkbox.

---

## 6. Transcript excerpt default — bounded, turn-aware, previewed

Decided: **not the full transcript.** Two reasons — transcripts get large, and
they're the most sensitive surface (users paste code, env output, occasionally
secrets).

- **Default: the last ~10 turns of the current session**, with individual tool
  outputs trimmed (a 1,200-line file-read clipped to a stub), the whole excerpt
  hard-capped at `MAX_TRANSCRIPT_LEN` (~25 KB).
- Budget by **turns + size**, not raw JSONL line count (a "line" can be one huge
  tool result). If a raw-line floor is ever needed, ~100 lines is the honest
  minimum that reliably contains a full recent exchange; below that risks cutting
  the very turn that shows the bug. Turn-aware + size-capped beats any fixed line
  count.
- **Always previewed** (§5), with the option to include more/less if the default
  window missed the relevant moment.
- Rationale copy shown inline on the toggle: "So we can see what led to the bug."

---

## 7. The tracking view — **"Feedback & requests"**

**Screen:** `mockups/04-feedback-and-requests.html`

Name chosen: **Feedback & requests** (rejected: "My Reports" — reads as
charts/dashboards; "Sent to the team"; "Your requests"; "Outbox").

- Opens from the help menu (and an Open-feedback palette entry). Lists what THIS
  install has sent, keyed by the anonymous `instanceId` — **no login required**.
- Each row: kind icon, message first line, kind + relative date, an attachment
  hint ("📎 screenshot, diagnostics") when present, and a **status badge**.
- **Status vocabulary (the four+ cockpit-visible states):** `Received` (grey) →
  `Triaged` → `In progress` (amber) → `Shipped vX.Y.Z` (green) / `Closed`.
  Mirrored from Linear via the webhook (spec Part 4); the cockpit never shows
  Linear internals (titles we rewrote, assignees, comments).
- Footer nudge: "Add your email to a report to get a note when it ships."
- Handle the empty state (nothing sent yet) and loading/error states — not just
  the happy path (REVIEW.md design bar).

---

## Consent posture (carried from the spec + ADRs, restated for implementers)

- Pressing **Send** is the consent boundary (ADR 260713-143958). The dialog's job
  is to make the payload legible before that press: identity shown, diagnostics
  and conversation previewable in full, scrubbing stated, privacy scope named.
- Identity is resolved **server-side** from the verified session, never trusted
  from a client field (ADR 260803-205037). The "Sending as…" line is display; the
  authority is the server.
- Diagnostics/conversation are **private to the core team, never public** — the
  opposite of the GitHub path (which is a public issue thread the user edits
  themselves). This distinction should be legible to the user, which is why the
  in-app path and the GitHub path read differently.
