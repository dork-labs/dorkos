---
covers:
  - 'feat(community): show the owner replacement in the Community browser app (DOR-2542)'
  - 'fix(community): give the owner-replacement banner its own React key (DOR-2542)'
  - 'fix(community): promise a password-less owner only what a password would open (DOR-2542)'
  - 'fix(community): read the reason for a longer wait from the request (DOR-2542)'
---

### Added

- The Community site now has every page for replacing an owner who has left. Hosts get an Owner part on each community's record: ask to replace the owner, see each request's progress in plain words, cancel it, or send the claim link again. The owner sees a banner with Keep ownership and only the choices they really have, and an owner without a password is no longer told a password would let them hand on a community that is archived or on hold. Admins see that a request is open. Everyone sees a note for a week after a new owner takes over. The emailed link opens a page with one Keep ownership button and no sign-in, and the new owner's link opens a page that says when they can take over. Asking for a replacement is still refused for now, until the owner is also told in the DorkOS app. It will open up in a later release (DOR-2542)
