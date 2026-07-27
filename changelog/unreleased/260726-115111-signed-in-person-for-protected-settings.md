---
covers:
  - 'fix(security): protected settings need a signed-in person, when login is on (DOR-505)'
---

### Security

- With **Require login** on, the settings screen now insists on a person, not just an account. Changing the settings that protect your instance (whether login is required, the key for the tool endpoint, the folder DorkOS may touch, the programs it may start, your privacy choices) now needs someone actually signed in to DorkOS. A program holding one of your API keys is refused, where before a key was enough to turn login itself back off. Nothing else about signing in changed (DOR-505).
- Three of those settings can also be changed from their own buttons elsewhere, and those paths are not guarded yet at all: connecting a model provider, starting your public web address, and linking this instance to a DorkOS account. They do not check who is calling, so this is unchanged whether **Require login** is on or off. The approvals guide says which is which, and we are closing them separately (DOR-505).
- Worth knowing if you leave **Require login** off, which is the default: nothing changes there, and nothing can. A program on your own computer that hides the fact it is an agent looks exactly like you clicking a toggle in Settings, so DorkOS has nothing left to tell the two apart. Turning on **Require login** is what closes it. The approvals guide now spells out which of the two you have (DOR-505).
