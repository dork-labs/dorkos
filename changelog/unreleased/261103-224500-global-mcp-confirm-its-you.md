---
covers:
  - 'feat(server): a person''s Allow on a server for every agent asks "Confirm it''s you" (DOR-3802)'
  - 'fix(server): a list of servers for every agent masks arguments and addresses (DOR-3802)'
  - "fix(server): a global server's arguments hide a secret after any name, not only a flag (DOR-3802)"
---

### Security

- Adding or changing an MCP server for every agent, or turning one on, now asks for your password first. The confirm says what will run and never shows a secret. Nothing is saved until you confirm (DOR-3802).
