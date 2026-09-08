---
covers:
  - 'fix(runtimes): keep server secrets out of agent environments'
---

### Security

- Stop passing the full DorkOS server environment to coding agents and their setup commands. Standard model sign-ins and operating system settings remain available. Custom tools that need extra variables now require an owner-approved list of names. Restart DorkOS after updating that list (DOR-1904).
