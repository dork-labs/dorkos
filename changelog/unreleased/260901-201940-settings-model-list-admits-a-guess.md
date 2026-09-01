---
covers:
  - 'fix(client): the settings Model row admits an unconfirmed catalog (DOR-1674)'
---

### Fixed

- The Model dropdown in Settings → Runtimes now tells you when its list is a shortened, unconfirmed one. Before a provider is connected, the composer's model picker already said "connect a provider to see the models you actually have" — but the same list in Settings showed nothing, so it looked complete when it wasn't. Both places now say the same thing (DOR-1674)
