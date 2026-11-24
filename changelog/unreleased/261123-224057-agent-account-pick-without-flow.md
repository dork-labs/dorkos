---
covers:
  - 'fix(accounts): an agent can start a chat on a named account while Flow is off (DOR-5033)'
  - 'fix(accounts): agents pick only accounts a person opened to them while Flow is off (DOR-5033)'
  - "fix(accounts): Main's own account row never offers to let agents pick it (DOR-5033)"
  - "fix(accounts): the guards read Main's own row, the confirming caller and the new pin as they ship (DOR-5033)"
---

### Fixed

- Agents can start a chat on a Claude account you choose even while Flow is off, still loading or fails to load. Before, every such pick was refused. To allow it, open Settings → Runtimes and turn on **Agents may pick this account** for that account. It starts off for every account, so nothing changes until you turn it on. Agents still can't pick your main sign-in, DorkOS credits, an account with **Move agents here automatically** turned off, or an account that is out of usage (DOR-5033).
