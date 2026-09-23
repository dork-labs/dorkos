---
covers:
  - "fix(server): show an agent how to find a service's exact name when its request is refused (DOR-2231)"
---

### Fixed

- When an agent asks for a service by a name DorkOS doesn't know, such as "composio-emails", the refusal now tells it how to search for the exact name, and lists close matches when there are real ones (DOR-2231)
- When no services are set up in DorkOS yet, an agent's request now says so and names the one step for you: open Connections in the DorkOS app and set up Accounts (DOR-2231)
- Agents are now told that signing in to a service's command-line tool in a shell does not give DorkOS access. Before, nothing said so, and an agent could spend a turn installing one (DOR-2231)
- A service an agent can find in DorkOS's service list is now a service it can ask for. Before, a request could be turned away while your linked DorkOS account was reconnecting, or when the list was too long to check in one go (DOR-2231)
- Asking for a Messaging-only service like Telegram now tells the agent that you set it up under Messaging, instead of sending it back to search again (DOR-2231)
