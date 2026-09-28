---
covers:
  - 'feat: show what a connected-app action does on its approval card (DOR-2504)'
---

### Changed

- When an agent asks to do something in a connected app that can't be undone, like deleting an email in Gmail, the card that asks you now says exactly what it is. It shows the app's logo, which account, the action in plain words ("Delete message"), and the details the agent would send, such as which message. It also says plainly that the change can't be undone. Before, the card showed only two long codes, so you had to approve without knowing what you were approving. Passwords, keys and other secret-looking details are never shown.
