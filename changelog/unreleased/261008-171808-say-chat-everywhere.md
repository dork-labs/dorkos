---
covers:
  - 'fix(copy): say "chat" in the app''s own copy (DOR-2789)'
  - 'fix(copy): say "chat" in server copy the app shows (DOR-2789)'
  - 'fix(site): say "chat" on the website (DOR-2789)'
  - 'fix(community): say "sign-in" and name the channel in space copy (DOR-2789)'
  - 'fix(cli): say "chat" in CLI output (DOR-2789)'
---

### Changed

- DorkOS now calls a conversation with an agent a "chat" in its menus, buttons, settings, errors, docs, website and command line. It used to say "session" in some places and "conversation" in others for the same thing. "New session" is now "New chat", the Sessions page is now Chats, and Session details is now Chat details. A chat an agent starts is a spin-off chat. Channels and DMs keep their names (DOR-2789)
