---
covers:
  - 'fix(connections): notice when a sign-in stops working and keep way status fresh (DOR-2501)'
  - 'fix(connections): record a sign-in status only when the service states one (DOR-2501 review)'
  - 'fix(connections): give the sign-in refresh its own deadline and narrow when the DorkOS account way waits (DOR-2501 review)'
---

### Fixed

- DorkOS now notices when a sign-in to one of your apps stops working. If a Gmail or Google Calendar sign-in expires or is turned off at the service, the app no longer stays green on the Connections page. DorkOS checks every 15 minutes and whenever you open Connections, and an agent that tries to use it is told you need to sign in again.
- When the way DorkOS reaches your apps has a short outage, it now comes back by itself. DorkOS checks again after 30 seconds, then waits a little longer each time, so you don't have to save your key again. A key the service refuses still waits for you to fix it.
