---
covers:
  - 'fix(client): the settings Model row admits an unconfirmed catalog (DOR-1674)'
---

### Fixed

- The model lists in Settings → Runtimes and on an agent's settings now tell you when they are shortened, unconfirmed lists. When OpenCode can't find any of your credentials, the composer's model picker already admitted it offers "a short list of models nobody has confirmed you can run" — but the same list on those two surfaces showed no notice, so it looked complete when it wasn't. All three places now say the same thing (DOR-1674)
