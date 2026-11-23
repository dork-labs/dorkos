---
covers:
  - 'fix(step-up): a page too old to confirm from reloads once by itself, and every refusal says why (DOR-5086)'
---

### Fixed

- "Confirm it’s you" no longer blames a mini app when none is the problem. When the page is simply older than a change, it shows "Updating this page…", reloads once, and opens the same request again for your password. If you typed something on the page, it doesn’t reload by itself. It offers a Reload button and says what reloading clears. When a mini app really is the reason, the message still names it (DOR-5086)
