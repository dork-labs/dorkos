---
covers:
  - 'refactor(ui): Relay''s "channels" are connections (DOR-523)'
  - 'test(tours): assert the Connections deep-link tab id (DOR-523)'
  - 'refactor(ui): rename Relay integrations from "Connection" to "Integration" (DOR-523)'
  - 'fix(ui): close the gaps review found in the channel-to-integration rename (DOR-523)'
  - 'fix(client): dispatch the room SSE events the rooms PR forgot to allowlist'
  - 'fix(server): stop hardcoding port 4242 in the extension-approval origin test'
  - "fix(relay): wire VITEST_RETRY into the relay package's vitest config"
---

### Changed

- The Settings tab where you set up Telegram, Slack, and webhooks is now called "Integrations" instead of "Channels" — same setup, clearer name now that "Channels" means something else in DorkOS (Slack-style conversations, coming soon to the sidebar).
- Each agent's "Channels" section, where you link it to Telegram, Slack, or a webhook, is now called "Integrations" too.
- A session badge that used to read "Channel" for messages arriving from Telegram, Slack, or a webhook now reads "Integration".

### Fixed

- A bookmark or shared link to the old Settings "Channels" tab now still opens the Integrations tab instead of silently opening nothing.
- The adapter setup wizard and a couple of "Add" buttons in the Relay panel and onboarding preview still said "channel" after the rename above; they now say "integration" too.
