---
covers:
  - 'feat(community): give every Continue-with button its provider mark'
  - 'refactor(community): one account clean-out shared by recovery and linking'
  - 'feat(community): link a matching account on sign-in, through one gate'
  - 'feat(community): ask for the account password on the sign-in page'
  - "fix(community): let the link panel's password field take focus normally"
  - 'fix(community): refuse sessions a sign-in made after its account was cleared'
  - 'fix(community): say how sign-in linking meets an email someone else used'
  - 'fix(community): record a trusted link only once its row exists'
  - 'fix(community): drop account rows a request wrote after its account was cleared'
---

### Added

- Show each sign-in button in a space with its own mark: the Google "G", the GitHub mark, and the DorkOS mark where the host turns it on, so "Continue with …" reads as a sign-in button (DOR-2709)
- Sign in to a space with Google, GitHub or single sign-on even when your email already has an account there: the page asks for that account's password once, then links the two and signs you in (DOR-2709)
- Let a host trust its own single sign-on with `COMMUNITY_OIDC_LINK_VERIFIED_EMAIL=1`, so a sign-in with a verified email links to the matching account straight away. If that account's email was never confirmed, its old password, sessions and other sign-ins are removed first, so someone who signed up with your email before you cannot stay in (DOR-2709)

### Changed

- Remove the server API keys and working invitation links an account made when its password is recovered, along with its sessions and connections (DOR-2709)

### Security

- Google and GitHub never link to an existing account without its password, and a sign-in whose email was not verified never links at all. Every link is recorded in the space's audit log, and mailed to the account where the host has mail set up (DOR-2709)
