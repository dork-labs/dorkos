---
covers:
  - "feat(connections): let an agent ask for an app DorkOS can't reach yet, and say why it can't (DOR-2494)"
---

### Changed

- An agent can now ask you for Gmail, Slack or another popular app even before DorkOS is set up to reach apps. The card in your chat walks you through the one-time setup first, then sign-in, then "Let your agent use Gmail?". Before, the agent was told there was nothing to ask for (DOR-2494)
- When your DorkOS account is no longer linked, or your own key stops working, DorkOS now says so plainly: the chat card, the setup step and your agent all name the fix, like "Your DorkOS account needs to be linked again", instead of asking you to connect the app again. Apps you connected through that account come back once it is linked again (DOR-2494)
