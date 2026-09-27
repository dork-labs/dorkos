---
covers:
  - 'feat(settings): add a Connections tab for how DorkOS reaches your apps (DOR-2419)'
  - 'fix(settings): make Settings › Connections honest about what each change stops (DOR-2419)'
  - 'fix(settings): name the Change-key confirm for what it does (DOR-2419)'
  - 'fix(connections): say when the DorkOS account check failed (DOR-2419)'
---

### Changed

- Settings has a new Connections tab. It shows each way DorkOS reaches your apps (your DorkOS account, your own Composio key, your own Nango server), whether it works, and how many apps use it. Before you change or remove a key, it lists every app that will pause or stop, and the button says how many (DOR-2419).
- Unlinking your DorkOS account in Settings › Access now lists the apps that stop working with it, too (DOR-2419).
- The chat app settings moved to the same tab, in plainer words: start working right away, most chats at once, and how many seconds a new message waits for a free chat before it's turned away. The Connections page now keeps to your apps (DOR-2419).
