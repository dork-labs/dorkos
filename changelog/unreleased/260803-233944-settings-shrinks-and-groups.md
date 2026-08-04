---
covers:
  - 'feat(settings): shrink to 10 tabs, grouped nav, retire Integrations & Agents tabs (DOR-858)'
  - 'feat(settings): plain names for the Tools tab groups (DOR-858)'
  - 'fix(agents): point the messaging empty-state buttons at Connections (DOR-858)'
  - 'fix(client): sidebar launcher label matches the Settings dialog title (DOR-858)'
  - 'fix(agents): DorkBot reads as the default agent on a fresh install (DOR-858)'
---

### Changed

- **Settings is shorter and grouped.** It went from twelve tabs to ten, sorted
  under plain headings: Agents & sessions, Access & privacy, System, and
  Add-ons. Appearance and Preferences stay at the top, and Remote Access stays a
  button at the bottom. The window, and the sidebar button that opens it, are
  titled "Settings" now, not "App Settings".
- **The default agent moves to the Agents page.** It used to be its own Settings
  tab. Now you open an agent's menu on the Agents page and choose "Set as
  default" — right next to the "Default" badge that already tells you which one
  it is.
- **Integrations left Settings for the Connections page.** Everything that tab
  did lives on the Connections page now, and old links to it still land there.
- **The Tools tab names what the tools do.** The groups you can switch on and off
  are Messaging, Agent discovery, Connection management, and Scheduling, instead
  of the names of the parts under the hood.

### Fixed

- **The "set up messaging" buttons on an agent's page led nowhere useful.** One
  opened a Settings tab with no messaging controls; the other opened a tab that
  no longer exists. Both now open the Messaging section of the Connections page.
