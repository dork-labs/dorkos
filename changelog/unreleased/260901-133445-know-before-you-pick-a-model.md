---
covers:
  - 'fix(server,client,shared): say what a model can do before you pick it, not after (DOR-1660)'
---

### Fixed

- Know before you pick: the model menu now says which models can't do the job, instead of letting you find out after you send a message. Models that can't use tools are grouped under their own heading, and a model that answers with pictures says so — DorkOS can't show generated images yet (DOR-1660)
- Stop offering OpenCode models that no longer exist. The menu is checked against what OpenRouter actually serves, so a model that was quietly retired upstream is no longer on the list. If that check can't be reached — on a plane, or behind a firewall — you get the full menu instead of a wait (DOR-1660)
- Choosing a model your runtime can't run is now refused right away with a clear message, rather than saved and failed on your next message (DOR-1660)
- The model menu refreshes when you connect a provider, sign in, or install a local model. It used to keep showing the old list for up to half an hour (DOR-1660)
- When OpenCode can't find any of your credentials, the menu no longer dumps thousands of unchecked models into the picker. It shows a short list and says plainly that nobody has confirmed you can run any of them, so a search that finds nothing no longer reads as "that model doesn't exist" (DOR-1660)
