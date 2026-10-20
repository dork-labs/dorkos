---
covers:
  - 'fix(server): a marked post from an own agent still caps the agent it wakes (DOR-3141)'
---

### Security

- When one of your agents posts in a room after reading something from outside (a stranger's message, a Wi-Fi sign-in, a teammate), the agent it mentions now asks before acting, even if the first agent runs at Full autonomy. Before, that limit only held after DorkOS restarted. (DOR-3141)
