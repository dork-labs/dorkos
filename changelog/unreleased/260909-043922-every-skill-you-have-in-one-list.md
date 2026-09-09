---
covers:
  - 'fix(harness): a reason no longer uses a retired word, and a guard keeps it so (DOR-1896)'
---

### Changed

- Your agent's profile now answers "what does this agent know how to do, and which of my tools can see it?" on one page. **Skills** lists every skill the agent has, wherever it came from, one line each, with a small tag per coding tool saying what that tool does with it — reads it, has a copy, out of date, or can't see it. Under the list, a panel per tool holds everything that tool cannot see and the reason for each, and a line at the top offers to bring what is out of date up to date. Every sentence on the page is the same sentence `dorkos harness sync` prints in your terminal, word for word, so the page and the command can never tell you two different things about one file (DOR-1896)

### Fixed

- One of those sentences had gone stale. Some packages bring along a part that connects DorkOS to Slack or Telegram, and the line explaining why that part stays inside DorkOS instead of travelling out to your coding tools still used an old name for it. It says Messaging now, which is what it is called everywhere else. DorkOS also checks its own wording from here on: a test reads every sentence this part of the app can print and fails if one of them slips back into a word the product has stopped using, so the next stale line gets caught before you ever see it (DOR-1896)
