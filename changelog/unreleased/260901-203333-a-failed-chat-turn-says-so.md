---
covers:
  - 'fix(client,server,shared): a failed chat turn says so, whatever the runtime called it (DOR-1676)'
  - 'docs(server,client,shared): say only what the rule can know, in the fragment and the docstrings (DOR-1676)'
  - 'fix(client,server,shared): one owner for the turn-failure rule (DOR-1676)'
---

### Fixed

- A chat turn that fails now says so. Some failures used to look like a clean finish: the session went quiet, the text explaining what went wrong disappeared, and you got a "finished" note instead of a warning. This happened whenever Claude Code named its own reason for stopping, like a model error, a problem reaching the service, or a prompt that ran too long. Now the session is marked with the error and keeps the explanation on screen, and if you are away from your machine DorkOS starts trying to reach you about it. Turns you stopped on purpose still show as stopped, and a turn that hit a snag and kept going still counts as finished (DOR-1676)
