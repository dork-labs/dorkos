# Browser Test Gotchas

Anti-patterns and hard-won lessons discovered during test creation. Read this before writing any new test.

## Selectors

- Avoid `getByText()` on dynamic content that changes between runs (timestamps, session IDs, message previews)
- Sidebar session items re-render on SSE updates; grab locators fresh after any navigation that triggers a sync

## Timing & Waits

- SSE streaming indicators have three states (`streaming`, `waiting`, `complete`) — always wait for the full lifecycle, not just `visible`
- `toHaveURL()` assertions can race with client-side router updates; pair with a visible-element wait on the target page

## Navigation & State

- Creating a new session via the UI changes the `?session=` URL param; tests that check session count must re-query after URL stabilizes
- Settings dialog is a modal overlay — it does not change the URL, so `toHaveURL` won't help; use `waitFor({ state: 'visible' })` on the dialog locator

## Dynamic Content

- Assistant messages stream in token-by-token; never assert exact text content mid-stream — wait for the inference indicator to reach `hidden` first
- Optimistic UI updates (e.g., message appears before server confirms) can cause stale element handles; re-locate after any mutation
