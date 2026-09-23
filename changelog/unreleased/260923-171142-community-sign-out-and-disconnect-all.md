---
covers:
  - 'feat(community): sign out, and disconnect one or every installation, from the Community site'
  - 'fix(community): limit password guesses on leave and disconnect-all, and name a wrong password'
  - 'fix(community): route every password confirmation through the guess limit'
  - 'fix(community): count password attempts per account, before the check'
---

### Added

- Sign out of a community site from the browser you are using. Find it in Settings, under Account, or on the page where you choose a community. Only that browser is signed out. Your memberships stay, and your connected DorkOS installations keep working. (DOR-2181)
- Disconnect all your DorkOS installations from a community at once. In Settings, under Account, confirm your password and every installation you connected there stops reading and posting until you connect it again. You stay a member, and your installations in other communities are not affected. (DOR-2181)

### Changed

- Each connected installation now says what it can do (for example "Can read and post") and asks before it disconnects. The question says what ends and that you stay a member. (DOR-2181)
- Leaving a community now lists what ends (your membership, its channels, and the installations and agents you connected there) and what stays (your account, your other communities, this browser's sign-in, and your past messages). A wrong password now says so and that you are still a member. Other refusals, like needing to transfer ownership first, now give their real reason. (DOR-2181)

### Security

- Limit password guesses everywhere a community site asks for your password: leaving, disconnecting all installations, handing over ownership, exporting the whole community, archiving, restoring or deleting it, and creating or replacing a host API key. After 5 wrong passwords in a minute, that account's password-protected actions are refused for the rest of the minute, even with the right password. Other people are never locked out by someone else's guesses, even when everyone reaches the server through the same proxy. A wrong password now always says "That password is not right." and that nothing changed. A server owner can change the number with `COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE`. (DOR-2181)
