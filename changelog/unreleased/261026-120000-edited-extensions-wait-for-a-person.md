---
covers:
  - 'fix(server): an edited extension waits for a person before its new code runs (DOR-3068)'
  - 'refactor(server): move the create_extension handler into its own module (DOR-3068)'
  - "fix(server): close the second review's gaps in the extension pin (DOR-3068)"
  - 'fix(server): resolve extension links by real path, and bind only pre-existing approvals (DOR-3068)'
---

### Fixed

- When you turn on an extension, you now approve its files as they are. If anything changes those files afterwards, the new code doesn't run until you look again. This covers extensions from the marketplace, plugins, and ones you turned on yourself, and an update to one of them asks again too. Agents can still edit an extension's files; DorkOS just won't run the changed code until you approve it. The Activity inbox shows one "changed since you approved it" row per extension and names the files that changed. If the files change again while that row is open, approving it is refused and the row refreshes, so you never approve code you didn't see. One kind of extension keeps working as an agent edits it: one the agent created itself, inside its own folder, that runs separately with limited access. If that kind asks for more access, it waits for you too. Even then, only its behind-the-scenes code keeps running: if the agent changes what it shows on screen, that part waits for you, and the inbox row says so. An update from the marketplace says it's an update and names both versions, like "Update Flow from 1.2.0 to 1.3.0?". Extensions you had already turned on keep running as they are after the update; their next change asks.
- A mini app an agent makes now lives in that agent's own folder, and you still see it in the side panel and on the Activity page whichever agent or folder you have open. Other agents running on Claude Code can't change its files with their file-editing tools. If an agent makes one after reading a message from someone outside your team, every later change to it waits for you.
- A mini app is now built only from files inside its own folder. One that imports a file from outside it, such as a shared folder next to it, no longer builds; move that file into the mini app's folder. Its own installed packages still work.
