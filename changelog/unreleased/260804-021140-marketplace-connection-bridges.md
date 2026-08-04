---
covers:
  - 'feat(marketplace): adapter cards bridge to Connections + install-toast deep-link (DOR-860)'
  - 'feat(marketplace): typed Connections deep-link + click-through test (DOR-860)'
  - 'fix(feedback): drop network-sense "connection" from the reports error copy (DOR-860)'
---

### Added

- Marketplace cards for messaging and service adapters now tell you what they become once installed: a messaging adapter reads "Adds a new way to reach your agents", and a service connector reads "Adds a new service your agents can act on", matching the two halves of the Connections page.
- After you install one of these, the confirmation gives you a one-tap way in: "Open Messaging" or "Open Accounts" takes you straight to the right part of the Connections page to finish setting it up.

### Fixed

- The feedback panel's "try again" message no longer talks about your network "connection", so it reads clearly now that Connections means something specific in DorkOS.
