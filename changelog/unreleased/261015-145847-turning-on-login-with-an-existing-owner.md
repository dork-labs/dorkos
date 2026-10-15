---
covers:
  - 'fix(auth): turning on login with an existing owner asks them to sign in (DOR-2964)'
  - 'fix(auth): put the password first so the turn-on-login dialog focuses it (DOR-2964)'
  - 'fix(auth): name the owner everywhere a login label shows, and never sign in as a guess (DOR-2964)'
---

### Fixed

- Turn on **Require login** when this computer already has an owner, and DorkOS now asks for that owner's password instead of a create-account form that could only fail. A wrong password leaves login off, so you can't lock yourself out. Forgot it? The dialog shows the command that resets it (DOR-2964)
- Stop showing your email as your name. New accounts no longer save the email as the name, and an older account whose name is just its email lets DorkOS ask what to call you (DOR-2964)
- Stop pointing to Settings › Login & security to change your email. Nothing there changes it, so the Profile hint now says so (DOR-2964)
