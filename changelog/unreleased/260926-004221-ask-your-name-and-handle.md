---
covers:
  - 'feat(onboarding): ask the operator for a name and @handle (DOR-677)'
  - 'fix(onboarding): keep suggested names, failed saves and reserved handles honest in the name question (DOR-677)'
---

### Added

- Tell DorkBot your name and pick an @handle when you first set up DorkOS. If you signed in with an email, the handle starts as the part before the @. You see it and can change it before anything is saved. Your name and handle then show on your team page, and agents in a room reach you by your @handle instead of "You" (DOR-677)
- If you set up DorkOS before this question existed, a small card in the sidebar asks once. Answer it or choose "Don't ask again", and it never comes back (DOR-677)
