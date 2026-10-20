---
covers:
  - 'fix(server): adding an approvals passkey returns to the computer by its address, never localhost (B4c follow-up)'
---

### Security

- After you make an approvals passkey, the browser now comes back to this computer by its address, never by the name `localhost`, which another program could point somewhere else. Adding a passkey on a computer that already has many security keys now stops at the start, before a passkey is made that couldn't be saved.
