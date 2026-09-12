# Disconnected Accounts implementation and verification

Disconnected accounts now appear in their own section. Owners can finish an interrupted disconnection, start a fresh sign-in, or confirm removal from Accounts. Removal preserves usage and revoked-access history. A new sign-in never restores old grants.

The combined DOR-1993 and DOR-1994 implementation includes the migration, owner route, account visibility rules, transport, UI, and generated API reference. Durable cleanup acknowledgements and generation snapshots fence old sign-in results. Concurrent disconnections share the outstanding attempt; managed cleanup continues checking its existing receipt.

## Verified source

Executable source was frozen at `796edd70079d4ea1e3abad79ebfc7503e873afd2`, tree `bfe27557797c2868ab3b83242a9e9a7287bcc8d7`. The final bookkeeping amendment changes only this specification directory. Independent review against `REVIEW.md` found no outstanding findings and independently passed 60 focused tests, including the migration.

The author passed 59 focused tests. Two negative controls failed when duplicate-delete protection or the stale-flow generation guard was removed; restored code passed. These cases include different returned account identities, late cleanup, older sign-in results after a newer reconnect, legacy unknown cleanup, and managed receipt recovery. Revoked grants remain revoked.

## Browser and required checks

One real browser regression passed against the isolated synthetic account stack: disconnect, find the Disconnected section, reconnect, disconnect again, observe a failed removal without losing the account, reload, confirm removal, and verify absence after another reload. The failure branch checks the visible safe error before reload. Desktop grouping and mobile confirmation screenshots passed independent visual review.

The browser ran from staged tree `6a04141fe5a9553f596ac571a6f1b6ab28aa7841`. Its runtime and browser-test inputs equal the frozen executable source. The only intervening change corrected test-only locator typing and formatting in `ConnectionsSurfaces.test.tsx`.

Required repository checks, lint, and typechecking passed. The affected test continuation passed all 34 tasks, including 15,017 client tests and 17,848 server tests. An unchanged harness Git-ignore test timed out once under load, then passed its isolated 21-test file and the normal 770-test harness suite. The subsequent normal pre-push gate also passed and published the branch.

These checks use synthetic accounts. They do not claim a new personal Gmail sign-in, email delivery, or live-model result. Final fetched-source review and the normal PR merge queue remain publication gates; implementation checklist completion does not claim the branch has merged.
