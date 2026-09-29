---
covers:
  - 'fix(connections): plain words everywhere in Connections (DOR-2505)'
---

### Changed

- Connections now speaks plainly when something goes wrong. Error lines, sign-in failures and what an agent is told no longer show internal words, raw app ids or status codes. A way to reach your apps is called by name, like "Your DorkOS account" or "Your Composio key".
- The line about who pays for an app is now true for every way you connect it. Apps on your own Nango server or MCP server no longer say usage is "billed to you", and apps on your own Composio key say the charges go to your Composio account.
- The key form for Composio now asks for your project key by name, and the messages after saving or removing a key no longer say "provider key". If the service turns a key down, you see one plain line instead of its raw error.

### Fixed

- The Nango line no longer promises that nothing leaves your systems. Your sign-ins stay in your own database, but actions still go out to the app itself.
- A request from a program to connect an app now shows the app's name, its status and where its sign-in is kept, instead of raw ids and a version number. If its sign-in didn't finish, it points you to the Connections page instead of asking for a request only the program could make.
