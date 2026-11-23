---
covers:
  - 'fix(step-up): a page too old to confirm from reloads once by itself, and every refusal says why (DOR-5086)'
  - 'fix(step-up): the Mac window offers Reload, and a page open across the update keeps its way out (DOR-5086)'
---

### Fixed

- "Confirm it’s you" no longer blames a mini app when none is the problem. When the page is simply older than a change, it shows "Updating this page…", reloads once, and opens the same request again for your password. If you typed something on the page, or another request is waiting, it doesn’t reload by itself. It offers a Reload button and says what reloading clears. The Mac app's window has the same Reload button. A page left open while you update DorkOS still offers "Sign in again", which reloads it. When a mini app really is the reason, the message still names it (DOR-5086)
