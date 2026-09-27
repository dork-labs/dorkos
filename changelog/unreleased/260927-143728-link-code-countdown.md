---
covers:
  - 'feat(cloud-link): show the time left on the link code, and say when the approval page will not open (DOR-2188)'
---

### Changed

- While you link this instance to a DorkOS account, Settings › Access now shows how long the code has left, counting down beside the waiting line and switching to "less than a minute" near the end. Screen readers hear the time when the code appears and again at five minutes and at one, not every second (DOR-2188)
- The button that opens the approval page now says **Open the approval page** (DOR-2188)

### Fixed

- If the approval page cannot be opened from the app, the panel now says so and tells you to copy the code and open the page in your browser, instead of the button doing nothing (DOR-2188)
