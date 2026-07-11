### Added

- Your agent can now read the console errors and failed network requests in its own preview. After it opens a page with `browser_navigate`, it can check its own work — catch a `TypeError` in the console or a 404 on a missing asset, fix it, and confirm the console is clean — without you relaying what went wrong (DOR-213)
