---
covers:
  - 'test(rooms): browser coverage for channels and direct messages (DOR-521)'
---

### Added

- Browser tests now cover channels and direct messages, so the kind of problem
  that kept slipping through gets caught before you see it. Every one of them
  looked fine in the old tests and wrong on screen: a channel showing its name
  twice, a screen reader saying it twice, letters where an agent's face belongs,
  a message box that would not send, a list that jumped away while you were
  reading back through it, and a mistyped name opening the wrong conversation
  (DOR-521)
