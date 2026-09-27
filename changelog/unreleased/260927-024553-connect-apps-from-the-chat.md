---
covers:
  - 'feat(connections): connect an app and allow access from a card in the chat (DOR-2415)'
  - 'fix(connections): honest chat card after a saved Allow, start on what was asked, safer links (DOR-2415)'
  - "fix(connections): keep the chat card's question on screen through a save, and no room-turn links (DOR-2415)"
  - 'fix(connections): answer a chat request with the access the chat really has (DOR-2415)'
  - "fix(connections): give the chat card's link only to a known direct message (DOR-2415)"
  - 'refactor(connections): agents never receive a DorkOS link for a request (DOR-2415)'
  - 'refactor(connections): name services with the shared helper, not a local copy (DOR-2415)'
---

### Added

- When an agent asks for an app you have not connected, a card now shows up right in the chat where it asked. Connect the app and let that one agent use it, without leaving the chat. The agent then picks up your original request by itself (DOR-2415)
- The card shows why the agent asked and what it wants to do, and starts on the access that covers it. If you give it less, the card says what it will not be able to do, and so does the agent's answer (DOR-2415)
- If the app is already connected, the card only asks whether this agent may use it, and says so when every agent already can. With two accounts, it asks which one first. A paused or signed-out account can be fixed right from the card. Choosing "Not now" tells the agent no (DOR-2415)
- The same card appears in a room when one of its agents asks, and only you see it. If you're talking to an agent over Telegram or Slack, the request waits for you in DorkOS: in the chat where it asked, or under Needs you on Connections. DorkOS never sends a link into those chats. If a chat has the app turned off, the card says so. A request that also asks to hear about new activity opens the full review on Connections (DOR-2415)
- Answering a request in one window now updates every other open window, including the Needs you list on Connections (DOR-2415)
