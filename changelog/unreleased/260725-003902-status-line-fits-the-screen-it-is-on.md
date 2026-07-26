### Changed

- The status line now measures the space it actually has and fits itself to it, instead of guessing from the screen size. On a narrow window it keeps the things most likely to be a real problem — a dropped connection, a nearly-full context window, a usage limit — and shows how many it left out as a small `+2` beside the `⋯`. Everything it left out is still in the Session panel, one tap away (DOR-452).
- Status items are easier to hit on a phone: every one of them, and the `⋯`, now has a touch-sized target (DOR-452).

### Removed

- Swipe-to-collapse on the status area is gone, along with its drag handle and the "Swipe to collapse" hint. It existed because the status area used to be up to five rows tall; it is now one row of at most a few items, so there is nothing left to collapse (DOR-452).

### Fixed

- Status items that did not fit used to be genuinely unreachable on a phone — the row looked scrollable and faded at the edge, but a gesture on the row above ate the swipe. The line no longer scrolls or wraps at all, so nothing can hide there (DOR-452).
- A screen reader now announces what the strip above the message box says — "Waiting for your approval", a finished turn's summary — instead of staying silent. The parts that tick every second, like the thinking verbs and the timer, stay quiet so the announcement is not drowned out (DOR-452).
