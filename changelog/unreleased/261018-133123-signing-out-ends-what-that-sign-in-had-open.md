---
covers:
  - 'feat: signing out ends what that sign-in had open, and you can see your signed-in devices (DOR-2969 part 2)'
---

### Added

- Settings → Login & security now lists your signed-in devices: how each one connects, when it was last used, and which one you're on. Sign out this device from anywhere. Other devices, and "Sign out everywhere else", can be signed out only from the computer DorkOS runs on. (DOR-2969)

### Security

- Signing out now really ends access. Chats, live updates and terminals that device had open close right away, instead of running until they reconnected. After `dorkos auth reset-password`, a running DorkOS closes them within a minute. (DOR-2969)
