---
covers:
  - 'feat(ui): a quieter Button, big enough for a thumb, with a real busy state'
---

### Changed

- Most buttons lose their outline and shadow and become a soft grey tint, so they read clearly on every background, sidebar included.
- On a phone, every button is now at least 44 pixels tall, the small ones too.
- Keyboard focus looks the same on every button: an orange outline with a small gap around it. It also shows in high-contrast modes, where the old ring disappeared.
- Delete buttons are one red everywhere, in light and dark.

### Fixed

- Deleting a schedule no longer resizes the button while it works, and keyboard focus stays on it.
