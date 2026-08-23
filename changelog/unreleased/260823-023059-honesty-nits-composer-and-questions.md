---
covers:
  - 'fix(client,server): stop no longer double-restores a queued edit, and a live question shows its real countdown (DOR-1323)'
  - 'fix(client): a queued rewrite survives Stop even when its own save has not finished yet (DOR-1323)'
---

### Fixed

- Pressing Stop while you were editing a queued message no longer pastes that message's text into the box twice.
- Pressing Stop right after rewriting a queued message now always keeps your rewrite, even if the save to the server hadn't finished yet.
- A question your agent asks now shows its real time-to-answer right away, instead of showing zero until the page refreshes.
