---
covers:
  - 'feat(connections): decide once, on the server, whether each connected app is usable and its one fix (DOR-2500)'
  - "fix(connections): read each agent's own access, show readiness per chat, and make Check again really check (DOR-2500)"
  - "fix(connections): keep the owner's pause through a sign-in again, and say no fix where none exists (DOR-2500)"
---

### Changed

- Connections now shows an app as ready (the green dot) only when your agents can actually use it. If the way DorkOS reaches it stopped working, or your key can sign in but can't run actions, the app says so instead of looking fine (DOR-2500)
- Every app that needs something shows one line saying what's wrong and one button that fixes it: Sign in again, Resume, Fix the key, Connect again, or Check who can use it. When there's nothing you can press, it says what DorkOS is doing, or what you can do in the app's own settings, with no button that can't work (DOR-2500)
- Your agent now learns why it can't use an app you gave it (paused, signed out, turned off for this chat, a change to its access still applying or refused, and more) and tells you the one thing to do, instead of asking you for access again (DOR-2500)
- A chat's side panel now says, for each connected app, whether its agent can use it here and why not, in the same words as the Connections page (DOR-2500)
- When your own key didn't answer for a reason that may pass, the app now says DorkOS checks it again on its own, instead of asking you to fix a key that works (DOR-2500)
- Signing in to an app again no longer quietly resumes an app you had paused. It stays paused until you resume it (DOR-2500)
- "Check again" on an app your DorkOS account can't reach now asks DorkOS to try the account again, rather than only re-reading the list (DOR-2500)
- Settings › Connections no longer says "Working" for a DorkOS account that can't reach apps, or for a Composio key that can't run actions. The key hint now asks for a project key (DOR-2500)
