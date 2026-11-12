---
covers:
  - 'fix(mcp): throttle remote credential guesses before verification (DOR-4205)'
---

### Security

- After ten wrong tool keys from one device in 15 minutes, DorkOS stops checking keys from that device until the window passes. Other devices and this computer are not affected.
