---
covers:
  - "feat(community): optional single sign-on through the host's OpenID Connect provider"
---

### Added

- A Community host can now let people sign in through its own OpenID Connect provider, beside email and password. The sign-in page shows one more button with the name the host chose. Joining still needs an invitation, the provider must confirm the email address, and single sign-on never attaches itself to an account that already exists here. You link it yourself from Settings, Account.
- Someone who signed up through single sign-on, Google or GitHub can add a password under Settings, Account. They can then still sign in when the provider is down. Actions that ask for a password, like exporting or leaving, now say "Set a password in your account to do this." instead of saying the password is wrong.
