---
covers:
  - 'fix(harness): a reason no longer uses a retired word, and a guard keeps it so (DOR-1896)'
---

### Fixed

- One line on your agent's Skills page had gone stale. Some packages bring along a part that connects DorkOS to Slack or Telegram, and the line explaining why that part stays inside DorkOS instead of travelling out to your coding tools still used an old name for it. It says Messaging now, which is what it is called everywhere else. DorkOS also checks its own wording from here on: a test reads every sentence the file-sharing engine can print — why a tool cannot see a file, what is in the way of writing one, what a sync would delete, what is out of date in the file that lists which tools you share to — and fails if one of them slips back into a word the product has stopped using, so the next stale line gets caught before you ever see it. The page itself is now opened and clicked through in a real browser on every run, against a real folder on disk (DOR-1896)
