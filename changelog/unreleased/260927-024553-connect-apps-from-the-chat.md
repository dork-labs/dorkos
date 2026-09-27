---
covers:
  - 'feat(connections): connect an app and allow access from a card in the chat (DOR-2415)'
---

### Added

- When an agent needs an app you have not connected, a card now shows up right in the chat where it asked. Connect the app, let that one agent use it, and the agent picks up your original request by itself. You never have to open Connections (DOR-2415)
- If the app is already connected, the card only asks whether this agent may use it. With two accounts of the same app, it asks which one first. Choosing "Not now" tells the agent no (DOR-2415)
- The same card appears in a room when one of its agents asks, and only you see it. An agent you reach through Telegram or Slack sends you a link back to the conversation instead (DOR-2415)
- Answering a request in one window now updates every other open window, including the request list on Connections (DOR-2415)
