---
covers:
  - 'fix(community): readable muted text, underlined links and 44px phone targets on the Community site'
  - 'fix(client): name the connection switch, size alert dialog buttons for phones, and point unfinished disconnects at the right place'
---

### Fixed

- Small grey text on a community site is now dark enough to read against every background, and links inside text are underlined, so you can tell them apart without relying on colour. (DOR-2182)
- Every button and field on a community site is now at least 44 pixels tall on a phone, including the menu button that opens the channel list and the owner claim field in host administration. (DOR-2182)
- The on/off switch on each messaging connection in Connections now says which connection it turns on or off, so a screen reader no longer reads it as just "switch". (DOR-2182)
- The two buttons at the bottom of a confirmation, like "Keep connected" and "Disconnect", are now full-size touch targets on a phone. (DOR-2182)
- When DorkOS disconnects from a community it cannot reach, the message now tells you to finish under Connected installations on that community, which is where the Disconnect button now lives. (DOR-2182)
