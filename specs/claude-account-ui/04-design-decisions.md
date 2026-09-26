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

## 5. Chosen in this spec (not a new visual decision)

- **The palette** (§5 of the spec): 8 colors, blue, green, amber, purple, pink, teal, indigo, stone, each at least 3:1 against every surface a dot sits on in both themes. The first four follow the mockups' order. The brief asked the spec to choose it.
- **Bar color thresholds:** a bar turns amber at 70%, read off the mockups (72% amber, 40% green); the chip's amber rule stays 90% as decided.

## 6. Open design questions

Listed with a proposed default in the spec, §14. None is decided here; each needs the operator in the visual companion.

- ~~Q0. Notice placement.~~ Decided: A, with the states above.
- Q1. Flow has no hold: in automatic mode "Wait for reset" and an unchecked "Continue automatically" cannot stop flow's own supervisor.
- Q2. Can a person pick an account shown as "kept in reserve"?
- ~~Q3. Wording for a session no flow run owns.~~ Resolved by §4 above; only the picker subtitle wording is this spec's.
- Q4. Exact place of the sidebar dot among the row's existing marks, and whether the row keeps printing the name.
- Q5. Drop "· started on this account" from the popover (always true today).
- Q6. How a window with no reading looks (never as 0%).
- Q7. The look of the restyled pre-launch picker.
- Q8. The control for choosing an account's color.
- Q9. How "+ add" takes a new repo.
- Q10. The marker's exact look (one muted line with a small icon).
- Q11. Whether "Continue here anyway" is remembered or per window.
- Q12. The reset-ready wording ("Acct 4 has reset." + Continue).
- Q13. Whether the calm states (waiting, reset-ready, moved) keep the red banner tone.
- Q14. Whether a moved session keeps a tint or text in the sidebar.
- Q15. Whether and how to show spend-only usage (OpenCode) in Settings.
- Q16. Cross-runtime fallback per runtime pair, beyond one fleet-wide toggle.
