# Design decisions

Every visual decision this spec builds on, where it came from, and what is still open. The operator made them in visual-companion sessions on 2026-09-26. The mockups are saved in [`design/`](design/). They are visual-companion fragments (no page shell), so open them in a browser as they are; each uses its own inline styles.

| File                                                           | Session                                                                                  | What it shows                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`design/account-display.html`](design/account-display.html)   | account display (copied from marketplace `specs/flow-fleet/design/account-display.html`) | Options A, B, C for showing a session's account. **C chosen.**                               |
| [`design/accounts-split.html`](design/accounts-split.html)     | settings split                                                                           | Options A and B for where account roles live. **A chosen.**                                  |
| [`design/account-limit.html`](design/account-limit.html)       | out of usage (first round)                                                               | Options A (banner) and B (transcript card) for the notice, and the picker both use.          |
| [`design/account-limit-v2.html`](design/account-limit-v2.html) | out of usage, without vs with flow                                                       | The same two placements, each without and with flow, and the picker both ways. **A chosen.** |

## 1. Showing which account a session spends: option C

Source: marketplace `specs/flow-fleet/04-design-decisions.md` (merged), mockup `design/account-display.html` option C.

- **Only when 2 or more Claude Code accounts are configured** and the session runs Claude Code. With one account nothing new shows.
- Each account has a short name (its `label`) and a color from a small fixed palette, chosen in Settings → Runtimes, default by position. Colors are only dots or badges, never large backgrounds.
- **Status-bar chip** next to the runtime chip: the dot, the name, two tiny vertical bars (5-hour, then weekly) filled to their used share.
  - Near a limit (`allowed_warning`, or any window at 90% or more): amber chip naming the window, e.g. "Acct 3 · 91% of week".
  - Out (`rejected`): red chip naming the reset, e.g. "Acct 4 · out until Tue 3pm".
  - Click → popover: name and plan type; one row per window with percentage, bar and local reset time; the tracker item the session serves; **"Continue on another account →"**.
  - Before launch, the chip is the existing account picker, restyled to match.
- **Sidebar rows:** a color dot at the start of every Claude Code session row. An out session gets a soft red row tint and the text "out · handing off" (or "out · waiting for reset" when handoff is `ask`).
- **Session header:** a small outlined badge after the title with the dot and the name.
- **Accessibility:** color is never the only signal. The name is always in the chip and badge; each sidebar dot has the name as its accessible label and tooltip. Amber and red states also say what happened in words.

Spec: §6.1-6.4.

## 2. Settings split: option A

Source: mockup `design/accounts-split.html` option A (operator's pick, relayed 2026-09-26).

- **Core, Settings → Runtimes → Claude accounts:** each account's name, color, path and live 5-hour and weekly bars.
- A one-line note under the list: **"Flow uses these accounts for your work. Choose how in Settings → Flow."** Only when the Flow extension is active and there are 2+ accounts. It opens tab `flow:fleet`.
- **A separate "Flow" tab** (settings.tabs slot, group Add-ons, extension `flow`, tab `fleet`), only when the flow plugin's extension runs:
  - Heading "Which accounts flow may use", and "Flow spends the account whose unused time expires soonest, and saves Main for last."
  - Per account: dot, name, segmented control **Main / Rotation / Kept out**.
  - Under Main: "Keep **50%** for me" slider (default 50%) and "Use it all in the last **24 hours** before it resets" (default 24 h).
  - Under Kept out: "Only for these repos" chips with remove, plus "+ add".
  - "When an account runs out": **Hand off automatically | Ask me**.
- Option B (flow's controls inside the Runtimes rows) was rejected: it needs a new core slot and mixes two concerns.

Spec: §6.5, §8.3.

## 3. When an account runs out

Source: mockup `design/account-limit.html`.

**Decided: the picker.** "Continue on another account" dialog, used by both notice options and by `ask` mode:

- Subtitle "Picks up in the same folder and branch from a checkpoint. It starts a new chat with a summary of this one."
- One row per eligible account: dot, name, usage left and reset ("28% left · resets Sun"); a **recommended** badge on the best one; Main shown dimmed as "kept in reserve (50%)".
- "Carries over: files, branch, checkpoint, task" / "Doesn't: the chat itself (a summary is passed on)".
- **Cancel** and **"Continue on <account>"**.
- The session header pill turns red: "● Acct 4 · out" (shown in both options).

**Decided: option A, a banner above the message box** (the operator delegated the pick; the orchestrator chose A, 2026-09-26; mockup `design/account-limit-v2.html`). When it resolves, the banner **collapses into a one-line marker in the transcript** at the point it stopped ("Acct 4 ran out · moved to Acct 2 at 2:14pm", "Resumed after reset at 4:02pm"). Its states, all the same banner with different text and actions:

- **near-limit:** the amber chip only, no banner.
- **limited:** "Acct 4 is out of usage until Tue 3pm." with **Continue on another account…** and **Wait for reset**. With flow in automatic mode: "Moving this task to ● Acct 2 in 10s…" with **Move now**, **Choose account…**, **Wait for reset**. The composer reads "Paused until you continue or the account resets" (with flow: "…until the task moves…").
- **waiting:** "Waiting for Acct 4 · back in 1h 12m" with a **Continue automatically when it resets** checkbox (on by default with flow, off without).
- **reset-ready:** resumes in the same chat, or offers Continue; the banner collapses to "Resumed after reset".
- **moved:** "This task continued on Acct 2 → Open it"; the composer is disabled by default, with a quiet **Continue here anyway**.
- **all accounts out:** "All accounts are out. Soonest back: Acct 2, Sun 9am", with only **Wait**.
- **model limit only:** "Opus is out on Acct 3 for this week." with **Keep going on Sonnet, same account** as the primary action.
- **Wording:** a 5-hour window says "back in 47 min"; a 7-day window says "out until Tue 3pm".

The v2 picker wording: without flow, "Starts a new chat in the same folder, with a summary of this one. Sorted by most usage left." and "Carries over: the folder and a summary of this chat" / "Doesn't: the chat itself"; with flow, "Picks up in the same folder and branch from flow's checkpoint.", "Client is kept out, so it isn't listed.", and "Carries over: files, branch, checkpoint, task" / "Doesn't: the chat itself".

Spec: §6.6, §6.7, §7.2.

## 4. Flow absent vs flow present (orchestrator decision, 2026-09-26)

After the operator asked what is flow-specific, the orchestrator decided:

- The out-of-usage notice and the picker are **DorkOS core UI** and work without flow.
- **Without flow:** the notice says "Acct 4 is out of usage until Tue 3pm" with "Choose account…" and "Wait for reset". The picker lists accounts by most weekly headroom, each with usage left and reset, with **no "recommended" badge and nothing hidden**. The carry-over list reads "a summary of this chat", not checkpoint or task.
- **With flow:** the server exposes an **account advisor** the Flow extension registers (rank and filter with a recommended id and reasons; what happens on a limit, an automatic countdown or ask; what carries over). The UI then shows the "recommended" badge, hides kept-out accounts, shows Main as "kept in reserve (50%)", shows the "Moving to Acct 2 in 10s… / Move now" countdown only in automatic mode, and names files, branch, checkpoint and task in the carry-over list.
- There is no flow-contributed UI slot for this.

Spec: §6.6, §6.7, §7.1, §8.4.

## 4b. Which runtimes and how many accounts (orchestrator, operator-confirmed, 2026-09-26)

Source: the programme's runtime decisions (RUNTIMES.md R7).

- The account chip, sidebar dots and header badge show **only when the session's runtime supports several accounts** (`supportsAccounts`, Claude Code only today) **and that runtime has 2+ registered accounts**. Never for Codex or OpenCode sessions today.
- Settings → Runtimes shows **usage bars for any runtime with usage data** (for example Codex's weekly window), even with one account, using the same bar.
- The out-of-usage banner applies to **any runtime** that reports it is out; when the account is implicit, the wording names the runtime ("Codex is out of usage until Tue 3pm").
- The picker lists the same runtime's accounts, plus a second **"Other runtimes"** group only when flow's cross-runtime fallback is on.
- The Flow tab lists accounts **grouped by runtime**, implicit accounts shown as "Codex (this computer's sign-in)", plus a **"Cross-runtime fallback"** toggle (off by default) in the same row and segmented-control pattern.

Spec: §4, §6.0, §6.5, §6.6, §6.7, §8.3.

## 4c. Cached usage and context in the status bar (operator ask via the orchestrator, 2026-09-26)

- The status bar's existing usage and context items show **cached data from the moment a session opens**, not only after a turn, for **all runtimes and a single account** (not gated like the chip).
- Usage is account-wide: every session on the same account shows the same numbers, and they update together.
- **No double display:** with 2+ Claude accounts the account chip absorbs the usage display; otherwise the existing usage item shows it.
- **Freshness:** "as of 12 min ago" in the popover or tooltip; numbers dimmed when older than about 60 minutes; a window whose reset has passed shows as reset or empty.
- Stay inside the existing chip's visual pattern; anything new goes to the open questions.

Spec: §6.8.

## 5. Chosen in this spec (not a new visual decision)

- **The palette** (§5 of the spec): 8 colors, blue, green, amber, purple, pink, teal, indigo, stone, each at least 3:1 against every surface a dot sits on in both themes. The first four follow the mockups' order. The brief asked the spec to choose it.
- **Bar color thresholds:** a bar turns amber at 70%, read off the mockups (72% amber, 40% green); the chip's amber rule stays 90% as decided.

## 6. Operator approvals of the open questions (2026-09-27)

The operator approved the proposed defaults (spec §14), with four answers that differ from what was proposed: Q13 (tone), Q1 (a wait on a flow run goes to flow, not "accept"), Q15 (show a spend line, not nothing) and Q18 (only while out, as a final rule). The orchestrator's behavioral answers are recorded beside them.

- **Q13 (changed):** the banner is **red only while an account is out and needs action**, and **neutral grey** for waiting for the reset, reset ready, and moved.
- **Q1 (changed):** a "Wait for reset" on a flow run is handed to flow (the advisor waits and resumes; DorkOS does not resume it too).
- **Q2:** a reserved Main is selectable but dimmed.
- **Q11:** "Continue here anyway" lasts for this reset window only.
- **Q15 (changed):** a runtime that reports spend but no windows shows a small "$4.20 spent this month" line in Settings.
- **Q16:** cross-runtime fallback is one fleet-wide toggle.
- **Q18 (changed):** "Continue on another account" shows only while the session is out.
- **Q21:** implicit accounts are stone.
- **Approved as proposed:** Q4 (dot leads the title, name in the tooltip), Q5 (omit "started on this account"), Q6 (dashed empty track and "unknown"), Q7 (pre-launch chip with a chevron), Q8 (swatch popover plus "Default"), Q9 (inline "owner/name" field), Q10 (one muted line with a small icon), Q12 (reset-ready wording), Q14 (no sidebar tint after a move), Q17 (muted number, "as of" line), Q19 (amber when only a model is out), Q20 (bar placement in Settings).

Spec: §14 (all resolved), §6.5, §6.7, §7.3 N10.

## 7. Flow tab: helping a new user set it up (operator ask via the orchestrator, 2026-09-27)

- A first-visit state that explains the three roles in one plain line each (Main: yours, kept in reserve and used last; Rotation: flow may use it fully; Kept out: flow never uses it), with a link to the guide `docs/use-all-your-accounts.mdx`.
- When no account is in rotation: "Nothing is in rotation yet, so flow only uses your main account."
- Built as a notice above the approved rows; anything beyond that is a design question.
- A core "we found ~/.claude2 on this computer, add it?" prompt was taken to the operator; decided in §8.

Spec: §8.3.

## 8. "Found on this computer" (operator decision, 2026-09-27)

Mockup: [`design/found-accounts.html`](design/found-accounts.html). **Option A chosen** (a list under your accounts); option B (a notice that opens a picker) was not.

- Below the registered accounts in Settings → Runtimes → Claude accounts, a dashed "Found on this computer" group lists unregistered Claude account folders: each with its name (the folder's name), "used N ago" and its path, plus **Add** (primary) and **Dismiss**.
- A folder that shows org-managed policy files gets an amber "managed by an organization" flag, and its Add is **not** primary: adding it must be deliberate.
- Dismissed folders stay hidden (saved).
- The group shows only when at least one unregistered folder exists, and disappears when empty.
- Nothing is added without a click.

Spec: §6.9, §7.4.

## 9. Four more calls (orchestrator, 2026-09-27)

- **Q22:** the Flow tab's guide link reads "How to use all your accounts".
- **Q23:** when roles are saved but no account is Main or Rotation, flow has nothing it may use, so the Flow tab shows a notice in the same style as the first-visit notice: "Flow can't use any account yet. Make one account Main or Rotation."
- Account dots and compact usage bars are not keyboard tab stops. They keep their screen-reader names and show the name in a tooltip on hover; the row or chip around them carries the account name.
- A window with no reading shows the word "unknown" in the compact usage bar too (with the dashed empty track, Q6).

Spec: §6.0, §8.3, §14.

## 10. The Flow panel (D11, orchestrator's option A, 2026-09-27; the operator deferred)

Mockup: [`design/flow-panel.html`](design/flow-panel.html). **Option A:** a "Flow" tab in the right-side panel, contributed by the Flow extension, shown only when flow is installed (option B, a section on the Activity page, was not chosen).

- **Accounts:** a dot, the name, two mini bars (5-hour and week), and state text ("out · resets Tue", "reserved").
- **Running:** flow runs with their item id and title, the account dot, and a state pill (building, in review, waiting on you, handing off, parked).
- **Footer:** "Pause flow" and "2 of 3 slots busy".
- Clicking a run opens its session; clicking an account opens its details.
- Q24-Q28 and the details the mockup does not show are decided in §11.

Spec: §8.5.

## 11. The Flow panel's open questions and details (orchestrator, 2026-09-28)

The operator left the panel to the orchestrator's judgement. Each call follows the host design system (its tokens, popover, focus ring and bar rule), so none needed a new operator review; the orchestrator shows the operator the final-state screenshots after the panel ships.

Copy and behaviour:

1. **Q24, nothing running:** one muted line, "Nothing is running."
2. **Q25, paused:** when every project is paused the button reads "Resume flow" and the slots text reads "paused"; when only some are, it reads "Pause flow" and pauses the rest.
3. **Q27, a run with no title:** the item id alone.
4. **Q28, resuming after `/flow:pause` switched schedules off:** a muted footer line, "Turn flow's schedules back on in Tasks."
5. **Load failure:** "Couldn't load Flow's status. Try again in a moment." with a Retry chip styled like the Flow tab's.
6. **Pause or Resume fails:** the fixed text "Flow didn't respond, so nothing was changed. Try again." (the Flow tab's save-failure line), never flow's raw error; the raw error goes to the browser console for debugging.
7. **The account chip can't be pinned** in the status bar (2.1): since a new pin value would be rejected by older builds' config (the lead's reason, accepted).
8. **The pre-launch account picker always shows** once the gate is open (Claude Code with 2+ accounts), even when the agent's default account can't be looked up (2.1).
9. **A "live" turn** (which blocks switching accounts) is one that is streaming or waiting on an approval (2.1).
10. **A DorkOS-hosted drain run (pid -1) can't be detected as stale**, so a dead one shows as running until flow releases its claim. Accepted; the follow-up is DOR-2490.

Visuals, each matching an existing host pattern:

11. **Q26, the account popover:** drawn by the extension with the decided content (name and plan, one bar per window with its reset time), styled like the host popover (its surface, border, radius and shadow), spanning the panel with a 12px inset (the size proposed with it and accepted).
12. **Row hover:** the host muted colour at 50%.
13. **Focus ring:** the host ring, 2px with a 1px offset.
14. **Disabled Pause** (nothing to pause): 50% opacity.
15. **Tab icon:** lucide `workflow`, drawn inline.
16. **State pills:** neutral, 10px foreground text in a border, fully rounded, no colour per state.
17. **Bars:** the host border colour for the track; the fill follows the host rule, green below 70%, amber from 70%, red at 100% or when the window rejected work.
18. **A window at 91% is amber**, not the mockup's red: the mockup's colour was illustrative, and the panel matches the status bar and Settings.

Spec: §8.5, §14.
