---
covers:
  - 'fix(mcp): the key refusal points to Login & security, and says when login comes first'
  - 'fix(settings): a link inside an open Settings dialog moves it to that tab'
  - 'fix(mcp): the login-off refusal and card name the "Ask for a password" switch'
---

### Fixed

- An MCP app on another device that DorkOS turns away now hears where to get a key: **Settings → Login & security → API keys**. Before, it was sent to a Settings card that has no keys. With login off, it's told to turn on **Ask for a password on this computer too** first, since keys need it.
- The **Connect other apps to DorkOS** card in Settings now links to Login & security, so you can make a key for another device in one click.
