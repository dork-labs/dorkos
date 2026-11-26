---
covers:
  - 'feat(api): one person bar for hand routes and the capability mount; its refusal no longer repeats the page’s address (DOR-4978)'
  - 'feat(api): six extension doors move onto the capability mount behind the person bar (DOR-4978)'
  - 'fix(api): the six extension doors take the proven owner on Wi-Fi and refuse a held device (DOR-4978)'
  - 'fix(api): Wi-Fi stays refused on the extension doors, and revoke and disable stay hand routes (DOR-4978)'
  - 'fix(api): a restart that fails after its reload answers as before, and the extension notes match the routes (DOR-4978)'
  - "feat(api): one person bar for hand routes and the capability mount; four extension doors move onto it; its refusal no longer repeats the page's address (DOR-4978)"
  - 'feat(api): a caller bar can take the front-door confirm-first hold; the confirm runs the bar afresh and must come from the same kind of caller (DOR-4978)'
---

### Changed

- When a page on another website tries to change something only you may change (your mini apps, project lookups, chat folders, account rules, the waiting-jobs list and similar), DorkOS now refuses it with one short sentence, "Open this from the DorkOS app.", instead of repeating that website's address back. Nothing else about who is allowed changed.
- Restarting a mini app, removing one, forgetting a removed one's permission and saying "Not now" work as before, at the same addresses. They now run the same "is a person asking?" check from one place, and can also be called by their action name at `/api/capabilities/{id}/invoke`, only by a person and behind the same check. Agents are still refused.
- In the API description, "Not now" is now named `extensions.dismiss_approval` (was `extensions.createDismissApproval`), forgetting a removed mini app's permission `extensions.forget_approval` (was `extensions.createForget`), and restarting one `extensions.restart` (new to the description).
- A "Not now" request that doesn't say which copy you were shown now gets the API's usual message naming the missing fields, instead of "Send the path and version of the extension you were shown."
- A few of their error messages no longer repeat the mini app's name. For example, "No extension named my-app is installed." is now "No extension with that id is installed."
- If a caller that is refused anyway (a page on another website, an agent, or someone not signed in while Require login is on) also sends a badly formed mini app id, the answer is now the refusal (403), not "bad request" (400).
- When a program uses an API key to make one of these changes (possible only while Require login is off), the activity log now names it as a program, not as you.
