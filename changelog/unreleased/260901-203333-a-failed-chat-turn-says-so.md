---
covers:
  - 'fix(client,server,shared): a failed chat turn says so, whatever the runtime called it (DOR-1676)'
---

### Fixed

- A chat turn that fails now says so. Some failures used to look like a clean finish: the session went quiet, the text explaining what went wrong disappeared, and you got a "finished" note instead of a warning. This happened whenever Claude Code named its own reason for stopping, like a model error, a problem reaching the service, or a prompt that ran too long. Now the session is marked with an error, keeps the explanation, and puts a note in your inbox. Turns you stopped on purpose still show as stopped, and a turn that hit a snag and kept going still counts as finished (DOR-1676)
