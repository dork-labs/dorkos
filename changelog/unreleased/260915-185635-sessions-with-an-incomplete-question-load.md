---
covers:
  - 'fix(sessions): a session whose agent asked an incomplete question loads again (DOR-2075)'
---

### Fixed

- Open a session again after its agent asked you a multiple-choice question and left out a detail, such as whether you could pick more than one answer. Before, the whole session refused to load and showed "Session not found". Now the question counts as pick-one, and a question with nothing readable in it no longer stops the rest of the conversation from loading. (DOR-2075)
