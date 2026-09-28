---
covers:
  - 'feat(connections): decide once, on the server, whether each connected app is usable and its one fix (DOR-2500)'
---

### Changed

- Connections now shows an app as ready (the green dot) only when your agents can actually use it. If the way DorkOS reaches it stopped working, or your key can sign in but can't run actions, the app says so instead of looking fine (DOR-2500)
- Every app that needs something shows one line saying what's wrong and one button that fixes it: Sign in again, Resume, Fix the key, Connect again, or Check who can use it. When there's nothing you can press, it says what DorkOS is doing, or what you can do in the app's own settings, with no button that can't work (DOR-2500)
- Your agent now learns why it can't use an app you gave it (paused, signed out, turned off for this chat, and more) and tells you the one thing to do, instead of asking you for access again (DOR-2500)
- Settings › Connections no longer says "Working" for a DorkOS account that can't reach apps, or for a Composio key that can't run actions. The key hint now asks for a project key (DOR-2500)
