---
covers:
  - 'fix(browser): Forget says plainly when the sign-ins folder was changed outside DorkOS, and records it (DOR-4172)'
---

### Fixed

- If the folder holding the Agent browser's saved sign-ins was changed outside DorkOS, **Forget…** now says: "Sign-ins weren't forgotten. Their folder was changed outside DorkOS, so DorkOS left it alone." It used to tell you to close the browser and try again, which could never work. What was found is also recorded in the audit log. (DOR-4172)
