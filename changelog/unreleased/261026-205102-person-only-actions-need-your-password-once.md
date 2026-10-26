---
covers:
  - 'fix(server): person-only actions need the person’s session at this computer (DOR-3330)'
---

### Security

- What only you can do in DorkOS now needs proof that it is you, even on the computer DorkOS runs on. That covers approving what an agent asked for, raising what agents may do, letting a mini app’s code run, approving an account connection, and posting as you in a room. The first time, DorkOS asks for your password once. After that, this browser stays confirmed on this computer, so it doesn’t ask again. Looking around and chatting never ask. Before, another program on this computer could do these things as you (DOR-3330)
