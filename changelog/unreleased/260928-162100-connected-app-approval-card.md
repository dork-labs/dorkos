---
covers:
  - 'feat: show what a connected-app action does on its approval card (DOR-2504)'
  - 'fix: let a destructive approval card show everything it sends and hide secrets in connected-app details (DOR-2504)'
---

### Changed

- When an agent asks to do something in a connected app that can't be undone, like deleting an email in Gmail, the card that asks you now says exactly what it is. It shows the app's logo, which account, the action in plain words ("Delete message"), and the details the agent would send, such as which message. If there's more than fits, "Show everything" opens every detail in full right on the card. It also says plainly that the change can't be undone. Before, the card showed only two long codes, so you had to approve without knowing what you were approving. Details that look like passwords or keys are hidden.
