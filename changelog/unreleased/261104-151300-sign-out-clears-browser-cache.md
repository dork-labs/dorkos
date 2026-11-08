---
covers:
  - 'fix(auth): erase boot cache across tabs on sign-out (DOR-3902)'
---

### Security

- Clear saved sidebar data from every open browser tab when you sign out, including automatic sign-out on public computers. Reloading another tab cannot bring the previous person's saved data back. (DOR-3902)
