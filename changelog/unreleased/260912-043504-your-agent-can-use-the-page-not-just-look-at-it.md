---
covers:
  - 'feat(workbench): teach the preview shim to click, type and read a page back'
  - 'feat(workbench): six browser verbs an agent can call on its own preview'
  - 'feat(canvas): one window answers when an agent drives the browser'
  - 'test(workbench): drive a real page in a real browser, in two windows'
  - "fix(canvas): type the bridge test's batch helpers as real ingest batches"
  - 'refactor(session): one no-preview sentence, and a barrel that names its callers'
  - 'fix(workbench): never submit a form the page told the browser not to'
  - 'fix(session): a seat nobody is sitting in yields, and cannot be taken by nobody'
  - 'fix(session): a tab behind another tab keeps its seat'
---

### Added

- Your agent can now use the page in the Browser tab, not just look at it. Ask it to try the signup form and it will: it reads the page to see what is on it, clicks buttons, fills in fields, presses keys, scrolls, and waits for the page to catch up — then tells you what happened, in the tab you are watching. It never pastes the page's HTML at you, and when several things match what it was looking for it says so and asks which one instead of guessing (DOR-2007).
- Every one of those answers names the page it acted on and where that page is now, so an agent with three previews open can tell you which one it used.

### Note for people upgrading

- Driving works in Claude Code sessions in this release. Codex and OpenCode get the same six verbs when the shared `ui` tool domain lands (DOR-2009).

### Changed

- A page that is open but cannot be driven now says so in one sentence, straight away. A page loaded straight from the internet is shown, not driven — and until now asking an agent to look at one meant an eight-second pause followed by a note about opening a preview that was already open.
- With the same conversation open in two windows, only one of them acts: the one that most recently brought a preview to the front. The other sees nothing, and a window you close hands the page back right away, and a window that stops responding hands it back after about a minute and a half. Screenshots follow the same rule, which settles a long-standing surprise where whichever window answered first won.
