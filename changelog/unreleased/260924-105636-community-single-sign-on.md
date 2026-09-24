---
covers:
  - "feat(community): optional single sign-on through the host's OpenID Connect provider"
  - 'fix(community): harden single sign-on and Google sign-in after review'
---

### Added

- A Community host can now let people sign in through its own OpenID Connect provider, beside email and password. The sign-in page shows one more button with the name the host chose. Joining still needs an invitation, the provider must confirm the email address, and single sign-on never attaches itself to an account that already exists here. You link it yourself from Settings, Account.
- Someone who signed up through single sign-on, Google or GitHub can add a password under Settings, Account. They can then still sign in when the provider is down. Actions that ask for a password, like exporting or leaving, now say "Set a password in your account to do this." instead of saying the password is wrong.

### Changed

- New passwords on a Community now need at least 12 characters, wherever you set one: signing up, first-time setup, adding a password, or recovery. A password you already have still works.
- Offline password recovery now also removes the account's Google, GitHub and single sign-on links, so whoever took over one of those accounts cannot get back in. Hosts can keep the links with `--keep-linked`.

### Fixed

- Security: a Community with Google sign-in accepted a bare Google ID token as a way to sign in, and any signed-in session could read back the tokens Google had issued. Together, someone holding an old token could start a new session without Google, which also got past the "signed in within the last five minutes" check that account deletion relies on. Sign-in now only goes through Google's own page, and those tokens are no longer handed out. The same rule covers the new single sign-on.
