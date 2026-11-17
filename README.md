# #3888 (DOR-3648) design shots

"Confirm it's you" for remote approvals and Always allow. Taken with headless Playwright on a test-mode server, a throwaway home and made-up data.

- `desk-card-*`, `desk-sheet-*`: at head `d3f2ba0b32`, real and unstaged. An owner is set and Always allow is clicked at this computer. The card stays in its asking state while the sheet is open.
- `remote-card-*`, `remote-sheet-*`: at head `b220d5f1b0`; the remote path is unchanged since. Three answers are staged with `page.route`: `/api/approvals/pending` (answering over Remote Access), the grant's 428 and `/api/step-up/:id`. The sheet note in these shots is the old wording.

Each in light, dark and 390px.
