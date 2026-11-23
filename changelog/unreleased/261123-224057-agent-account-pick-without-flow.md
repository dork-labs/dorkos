---
covers:
  - 'fix(accounts): an agent can start a chat on a named account while Flow is off (DOR-5033)'
---

### Fixed

- An agent can start a new chat on a Claude account you've added, even while Flow is turned off or fails to load. Before, every pick was refused. Without Flow, DorkOS decides on its own: never your main sign-in, never DorkOS credits, and never an account with **Move agents here automatically** turned off in Settings → Runtimes (DOR-5033).
