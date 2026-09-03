---
covers:
  - 'fix(server): a dropped tunnel is noticed, and a failed close no longer strands it (DOR-1738)'
  - 'fix(server): one answer for what the tunnel starts with, at boot and from the app (DOR-1738)'
  - 'fix(server): only a person can publish this machine, and the settings say what is true (DOR-1738)'
---

### Fixed

- Remote Access now comes back when you restart the desktop app. Turning it on in the app saved the setting, but only the command line ever read that setting back, so the desktop app started with the tunnel closed and nothing said why (DOR-1738)
- DorkOS now notices when a tunnel drops. It was asking ngrok to tell it, using a name ngrok does not answer to, so a tunnel that had died was still shown as connected until you turned it off by hand. And while a live tunnel is reconnecting, turning it on again says "it is already running" instead of failing with a server error (DOR-1738)
- A username and password you set for the tunnel in your environment is now actually used when you turn Remote Access on from the app. Before, the app started an open tunnel and then told you it was password-protected — the one direction that mistake must never point (DOR-1738)
- Your saved tunnel address no longer reads as empty after a restart, and Settings now shows both what is running and what you have saved (DOR-1738)
- When a tunnel fails to start or stop, the reason is written to the log. Someone who turned logging all the way up to find out why still saw nothing at all (#1458, DOR-1738)

### Security

- Your agents can no longer publish your machine to the internet. Opening a tunnel is one of the settings reserved for a person, but the button's own endpoint asked nobody, so anything on your machine that could reach DorkOS could open one. Closing a tunnel is still open to everything, on purpose — shutting off access should never be the thing that gets refused (DOR-1738)
