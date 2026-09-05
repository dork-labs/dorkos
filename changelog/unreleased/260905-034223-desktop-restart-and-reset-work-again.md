---
covers:
  - 'fix(desktop,client,shared,server): the desktop app restarts and resets through its own supervisor (DOR-542)'
---

### Fixed

- In the desktop app, Settings → Advanced → **Restart Server** and **Reset All Data** work again. Both used to ask the server to end itself and start over, which the app can't do — so the app refused, and the two buttons could only fail. Now the app restarts its own server: it stops it, deletes your data if you asked for that, starts it again, and puts your window back on it. If another copy of DorkOS is using the same folder, nothing is deleted and you are told which one to quit (DOR-542)
- Refusals from these two buttons read like sentences again. A message from the server used to arrive as the whole raw response — braces, error code and all — with the explanation buried inside it (DOR-542)
