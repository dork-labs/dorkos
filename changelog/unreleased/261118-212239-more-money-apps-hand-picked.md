---
covers:
  - 'fix(connections): Ramp, Metronome, Polar, Gift Up and PostGrid are money apps, and payroll, reimbursement and a few single money actions stay one-by-one picks (DOR-4624)'
---

### Fixed

- More actions that spend or move money now need to be picked for an agent one by one. Read and write, or sharing the app with every agent, no longer covers them:
  - every change in Ramp, Metronome, Polar, Gift Up and PostGrid;
  - running payroll or paying back expenses, in any app;
  - a few single actions in other apps, such as issuing a card, billing a customer or buying a phone number.
- Digital Humani charges for each tree it plants, so its actions are now marked as spending money too.
