---
covers:
  - 'fix(accounts): an agent can start a chat on a named account while Flow is off (DOR-5033)'
  - 'fix(accounts): agents pick only accounts a person opened to them while Flow is off (DOR-5033)'
---

### Fixed

- Agents can start a chat on a Claude account you choose even while Flow is off or fails to load. Before, every such pick was refused. To allow it, open Settings → Runtimes and turn on **Agents may pick this account** for that account. It starts off for every account, so nothing changes until you turn it on. Agents still can't pick your main sign-in, DorkOS credits, or an account that is out of usage (DOR-5033).
