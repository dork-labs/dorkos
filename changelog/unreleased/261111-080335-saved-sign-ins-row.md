---
covers:
  - 'fix(browser): the Agent browser panel shows one Saved sign-ins row, with a confirmed Forget (DOR-4105)'
  - "fix(browser): Forget clears every browser profile's sign-ins, and no one can make a new profile (DOR-4105)"
---

### Fixed

- The Agent browser panel now shows one **Saved sign-ins** row: "Kept apart from your own browser. Every agent here shares them." **Forget…** asks before it signs every agent out of every site, including sign-ins kept for any older named profile. It replaces the old list of profiles, and new named profiles can no longer be made. (DOR-4105)
