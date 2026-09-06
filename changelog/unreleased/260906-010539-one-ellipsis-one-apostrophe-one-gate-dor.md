---
covers:
  - 'fix(client,site,server): one ellipsis, one apostrophe, one gate (DOR-1756)'
  - 'fix(client): four failure screens, one vocabulary (DOR-1756)'
  - 'fix(client): the asks and the last stragglers say what they mean (DOR-1756)'
  - 'fix(client,site,scripts): review fixes for UI audit batch 10 (DOR-1756)'
---

### Fixed

- DorkOS used to spell an ellipsis two ways ("Saving…" beside "Saving...") and an apostrophe two ways, sometimes on the same screen. The app now spells both one way, and a check keeps new copy from drifting back (DOR-1756)
- When something goes wrong, DorkOS now says the same thing every time. The crash screen, the page-error screen and the "page not found" screen used to invent their own words for the same two buttons. They now all say "Try again", "Reload DorkOS" and "Back to home" (DOR-1756)
- A page that fails to load now tells you what happened in a sentence written for you, with the technical error tucked underneath, instead of showing you the raw error and nothing else (DOR-1756)
- Errors that used to start "Could not…" now start "Couldn’t…", and say what to try next (DOR-1756)
- When an agent asks you for something, the card now says "{name} needs something from you" and its button says "Done". Screen readers hear the same plain countdown the card shows: "Two minutes left to answer." (DOR-1756)
- Smaller labels that read like code now read like English: "Repository link" instead of "Git URL", "What this can do" instead of "Permissions & Effects", "Not protected" instead of "No auth", and "Reloaded 3 extensions" instead of "Reloaded 3 extension(s)" (DOR-1756)
- The banner about agents running unattended now says "connection", matching the rest of the app, and its Connections button actually opens Connections. It had quietly stopped working (DOR-1756)
