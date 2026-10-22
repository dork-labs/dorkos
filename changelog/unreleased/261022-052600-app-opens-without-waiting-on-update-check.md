---
covers:
  - 'fix(server): opening the app no longer waits on the update check'
---

### Fixed

- The app no longer waits on a slow connection to check for updates. On bad Wi-Fi it could take up to 5 seconds to open. Now it opens right away and checks for updates in the background.
