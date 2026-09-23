---
covers:
  - 'feat(client): route community switcher actions to the right authority'
  - 'fix(client): make community switcher links say where they go'
---

### Added

- The context switcher now has a **Manage** menu for the community you have open. **Invite people**, **Community settings** and **Leave community** open that community's own site, at the right page, where it checks your sign-in. The DorkOS app's own settings stay under **Workspace settings**, so the two never mix. **Disconnect** asks first, then removes only that community from this app. You stay a member (DOR-2185).
- **Add community** in the switcher now offers three separate paths. **Connect a community** links this DorkOS to a community you are already in. **Join with an invitation** opens an invite link you were sent on the community's own site. **Run your own community** opens the guide for setting up your own community server (DOR-2185).

### Fixed

- When a community stops accepting this DorkOS, for example after you leave it on its site, the app now clears that community's messages as soon as it notices, within about half a minute. If you had it open, you go back to your own DorkOS. Other communities are not touched (DOR-2185).
- Choosing a community that needs reconnecting, or **Connect a community**, now opens the Messaging part of Connections, where communities are, instead of Accounts (DOR-2185).
