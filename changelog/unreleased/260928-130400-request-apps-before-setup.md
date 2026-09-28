---
covers:
  - "feat(connections): let an agent ask for an app DorkOS can't reach yet, and say why it can't (DOR-2494)"
  - 'fix(connections): say plainly that relinking does not restore old connections, and offer Connect again (DOR-2494)'
---

### Changed

- An agent can now ask you for Gmail, Slack or another popular app even before DorkOS is set up to reach apps. The card in your chat walks you through the one-time setup first, then sign-in, then "Let your agent use Gmail?". Before, the agent was told there was nothing to ask for (DOR-2494)
- When your DorkOS account isn't linked anymore, or your own key isn't set up or didn't answer, DorkOS now says so plainly. The chat card, the setup step and your agent name the way that stopped working, and the card offers to connect the app again. Linking the account again does not currently restore connections made through the old link, so those apps show as disconnected once the account is linked again (DOR-2494)
