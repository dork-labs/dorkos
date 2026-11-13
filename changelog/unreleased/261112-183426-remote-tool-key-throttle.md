---
covers:
  - 'fix(mcp): throttle remote credential guesses before verification (DOR-4205)'
  - 'fix(mcp): a stranger on the tunnel can no longer lock out the owner’s tool key (DOR-4205)'
---

### Security

- After ten wrong tool keys from one device in 15 minutes, DorkOS stops checking keys from that device until the window passes. Other devices, this computer, and your own devices reaching DorkOS through remote access are not affected.
