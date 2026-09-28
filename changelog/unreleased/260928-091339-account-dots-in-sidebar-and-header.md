---
covers:
  - 'feat(sessions): show which account each chat uses in the sidebar and chat header (DOR-2387)'
---

### Added

- With two or more Claude accounts set up, each Claude Code chat in the sidebar now starts with a small dot in its account's color. Point at the dot to see the account's name (DOR-2387).
- A chat whose account ran out of usage now says so in the sidebar, where its time used to be: "out · handing off" when the work is about to move to another account by itself, "out · needs you" when it is waiting for you to choose what happens next, and "out · waiting for reset" once you chose to wait. The row turns light red only while it needs you. A chat you already moved to another account shows neither (DOR-2382).
- The chat header now names the account the chat uses, and adds "out" in red when that account ran out (DOR-2387).
- This computer's own Claude sign-in is now called "Main (this computer's sign-in)" everywhere DorkOS names an account, instead of its folder name ".claude" (DOR-2387).
