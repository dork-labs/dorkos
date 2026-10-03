---
covers:
  - 'fix(client): rewrite the remaining app copy to the app-copy standard'
  - 'fix(client): address review on the remaining app copy'
  - 'fix(client): bring the copy main added since the sweep to the standard'
  - 'fix(client): rewrite Connections copy to the app-copy standard'
  - 'fix(client): rewrite Settings copy to the app-copy standard'
  - 'fix(client): rewrite Rooms and community copy to the app-copy standard'
  - 'fix(client): rewrite agents, team and tasks copy to the app-copy standard'
  - 'fix(client): rewrite chat and session copy to the app-copy standard'
  - 'fix(client): rewrite marketplace and extensions copy to the app-copy standard'
  - 'chore(ci): make the copy-length check fail on blocks of 16 words or more'
---

### Changed

- The app's wording is shorter and plainer everywhere. No label, message or button runs past 15 words, and longer explanations sit behind an info button or a "More details" link next to what they explain
- Buttons say exactly what they do ("Delete agent", "Remove app"), and dialogs for things you can't undo ask a question that names the thing
- Approval buttons now read **Allow**, **Always allow** and **Don’t allow**, on chat cards and in the inbox
- Error messages say what didn't happen and what to do next

### Fixed

- Settings › Privacy no longer says DorkOS shares anonymous data by default. It now says nothing is shared unless a switch on that page is on
