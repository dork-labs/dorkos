---
covers:
  - 'refactor(ui): Relay''s "channels" are connections (DOR-523)'
---

### Changed

- The Settings tab where you set up Telegram, Slack, and webhooks is now called "Connections" instead of "Channels" — same setup, clearer name now that "Channels" means something else in DorkOS (Slack-style conversations, coming soon to the sidebar).
- Each agent's "Channels" section, where you link it to Telegram, Slack, or a webhook, is now called "Connections" too.
- A session badge that used to read "Channel" for messages arriving from Telegram, Slack, or a webhook now reads "Connection".
