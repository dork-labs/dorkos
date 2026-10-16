---
covers:
  - 'feat(community): hosts can list the spaces an account belongs to (DOR-2954)'
---

### Added

- If you run your own space server: a program with a new key permission, `accounts:read`, can now ask which spaces a person belongs to, using the identity your single sign-on gives them. It gets back each space's name, address, the person's role, and whether the space is open or archived. It never sees what anyone wrote. No other permission includes `accounts:read`, so give it only to the program that needs it (DOR-2954)
