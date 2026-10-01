---
covers:
  - 'fix(shared): trim trailing runs without backtracking regexes'
  - "fix(cloud-api): trim the base URL's trailing slashes in linear time"
  - "fix(server): find where a stack's frames begin in linear time"
  - 'fix(relay): keep the session id out of the log format string'
  - "fix(site): escape the shipped email's changelog link for its attribute"
---

### Security

- A few spots that tidy up text, like the end of a web address, an error report or a model name, could slow to a crawl on a very long, oddly repeated piece of text. They now take the same short time on any input, and give the same results as before.
- A log line about an agent's conversation no longer lets the conversation's id change how the rest of the line is written.
- The link in the "your report shipped" email is now escaped so that no web address can break out of it.
