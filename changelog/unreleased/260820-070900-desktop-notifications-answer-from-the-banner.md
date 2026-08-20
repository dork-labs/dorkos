---
covers:
  - 'feat(desktop): Electron native notifications with Allow/Deny/Reply, superseding the ADR 0009 ban (DOR-1386)'
---

### Added

- The desktop app now shows real system notifications. When an agent needs a yes or no, the
  banner has Allow and Deny buttons right on it, so you can answer without opening DorkOS
  (DOR-1386)
- On a Mac, a simple question from an agent can be answered right from the notification too:
  type your reply and it goes straight back to the agent (DOR-1386)
- Clicking a notification brings DorkOS to the front and opens the session it is about
  (DOR-1386)

### Changed

- These notifications stay quiet on their own (no sound) and only show up for the things worth
  interrupting you for, or for finished work while you are away from DorkOS. Everything else
  still waits for you in the app (DOR-1386)
