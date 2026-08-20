---
covers:
  - 'feat(shared,server): where you hid a promo card is remembered for your account, not just that browser (DOR-1369)'
  - "feat(client): the sidebar's bottom card is always visible, one at a time, and you can dismiss it (DOR-1369)"
---

### Changed

- The bottom of the sidebar shows one card at a time, and it stays put. Up to four things used to compete for that corner, and the "Use DorkOS on the go" card sat inside the scrolling list — so once you had more than a screenful of agents and channels, it slid out of sight for good. Now there is one spot, pinned just above the row of buttons at the bottom, and whatever matters most gets it: finishing setup, then an update that is ready, then the question about your work, then a tip (DOR-1369).
- Every one of those cards has an × now, and hiding one sticks. The tip cards had no way to say no at all. Your answer is saved to your account rather than to the browser you happened to be using, so a card you hide on your laptop stays hidden on your phone.
- "Use DorkOS on the go" only shows up when it means something — you are in a browser and you have not set up remote access yet. It used to show for everyone, forever.
- On a phone, the card appears at the bottom of Home. Phones never showed it at all before.
