---
covers:
  - 'feat: redesign the feedback form (DOR-2232)'
---

### Changed

- The Send feedback form is simpler. You write in one box, and your screenshot, the part of the app you pointed at, and the buttons to add them all sit inside that box. Diagnostics and the conversation are small switches under it, each with a preview (DOR-2232)
- The page with the reports you've sent is now called Your reports, in the help menu, its tab and its title (DOR-2232)
- The help menu has three items now: Send feedback, Your reports, and Documentation. Report a bug is part of Send feedback (pick Bug), and the public GitHub option is a link at the bottom of the form (DOR-2232)
- Pointing at part of the app no longer writes code names into your message. It shows up as a small picture named by the words on it, like "Set up a daily run", and the box asks what's wrong with it. You need to add a few words before you can send (DOR-2232)

### Added

- Not signed in? The form asks for your email, so we can tell you when your report is fixed. It remembers the address in this browser for next time (DOR-2232)
- On a phone, the You tab now has Send feedback, Your reports and Documentation as rows of their own, and the command palette has a Your reports entry (DOR-2232)
- Close the form by accident and your draft is still there when you open it again. Press ⌘↵ (Ctrl+↵ on Windows and Linux) to send, and the thank-you links to Your reports (DOR-2232)
- Sending the same report twice within a minute is caught, so it doesn't get filed twice (DOR-2232)
