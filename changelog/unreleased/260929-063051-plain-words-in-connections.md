---
covers:
  - 'fix(connections): plain words everywhere in Connections (DOR-2505)'
  - 'fix(connections): true labels, one way-name table and honest key checks (DOR-2505 review)'
  - 'fix(connections): plain words in agent requests and no more "delete" or "can''t be undone" for high-risk actions (DOR-2505)'
  - 'fix(connections): high-risk wording everywhere, Nango-only 404, key status that updates (DOR-2505 review 2)'
  - 'fix(connections): keep saying a key is being checked while the check runs (DOR-2505 review 3)'
---

### Changed

- Connections now uses plain words when something goes wrong. Its error lines and sign-in failures no longer show internal words, raw app ids or status codes. Ways to reach your apps are called by name everywhere, like "Your DorkOS account", "Your Composio key" or "The app's own MCP server".
- When DorkOS turns down an agent's action or request, the agent reads plain words and the app's name instead of internal terms and raw ids. The ids an agent needs to act on still come along, in their own place.
- The line about who pays for an app is now true for every way you connect it. Apps on your own Nango server or an app's own MCP server no longer say usage is "billed to you". Apps on your own Composio key say the charges go to your Composio account.
- Actions the service marks as risky now say "High risk" everywhere: in the access lists, on the approval card, in the warning about what every agent can do, in what an agent is told when it must wait for approval, and in Activity. They used to say "delete" or "can't be undone", which wasn't always true, because the service also marks sending and sharing this way. When the same action is listed twice, the older one says "Older version".
- The Composio key form now asks for your project key by name, and the messages after saving or removing a key no longer say "provider key". If a key check fails, you see one plain line. It says DorkOS will check again only while it really will, updates on its own once DorkOS stops, and says when DorkOS couldn't reach Composio or your Nango server at all.
- A chat app that stopped working shows one plain line. Its raw error is still there under "Details" if you need it for a bug report.

### Fixed

- The Nango line no longer promises that nothing leaves your systems. Your sign-ins stay in your own database, but actions still go out to the app itself.
- When your Nango encryption key is missing or the wrong length, the message now says to restart DorkOS after you set it, because DorkOS only reads it when it starts.
- A request from a program to connect an app now shows the app's name, its status and where its sign-in is kept, instead of raw ids and version numbers. If its sign-in didn't finish, it says why in one line and points you to the Connections page.
