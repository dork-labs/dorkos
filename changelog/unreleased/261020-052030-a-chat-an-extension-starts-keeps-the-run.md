---
covers:
  - "fix(server): a chat an extension starts keeps the runtime default under any caller's bound (DOR-3037)"
---

### Security

- A chat that an extension starts always asks before acting, whatever limit the request that started it carried. Before, a looser limit passed along with the request could replace that one. (DOR-3037)
