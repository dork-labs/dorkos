---
covers:
  - 'feat(client): a finished sign-in lands on a real DorkOS page that takes you back to the right app (DOR-2985)'
  - 'fix(client): Try again on the sign-in landing page reaches the app that is still watching (DOR-2985)'
---

### Changed

- After you sign in to an MCP server or OpenRouter, the browser now shows a proper DorkOS page. It matches your light or dark theme, names the service and the agent, and says what happens next.
- If you started in the desktop app, the page opens the desktop app for you, back in the chat that asked. If you started in a browser, its button takes you back there.
- When a sign-in is cancelled or fails, the page says so in plain words and offers **Try again**.
- The one-time sign-in code no longer stays in the address bar, so a copied link never carries it.
