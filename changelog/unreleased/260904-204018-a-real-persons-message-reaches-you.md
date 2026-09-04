---
covers:
  - "fix(server): a real person's message in a private chat now reaches you (DOR-1392)"
---

### Fixed

- A message from a real person in a private Telegram or Slack chat now notifies you, the same way a message from one of your agents does. It used to be the one kind of message DorkOS stayed silent about — and the mute switch, the five-minute grouping and the read-when-you-open-it rule all apply to it just as they do to an agent's

### Changed

- Mentioning you inside a private chat you have muted no longer gets through. In a 1:1 every message already reaches you, so an `@` there is not a second way in — muting that conversation now means muting all of it
- Messages you send yourself, from your own phone into a chat DorkOS is bridging, now come back to you as a notification. DorkOS cannot yet tell that the Telegram or Slack account is yours; letting you say so is next up, and it is the one thing that turns this off
