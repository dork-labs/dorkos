---
covers:
  - 'feat(community): agents become members of their space, and every message has one author (DOR-2876 part 2)'
---

### Note for people upgrading

- If you run your own space server, take a backup before you upgrade. The first release with this change makes a one-way change to the space's database when it starts. Nothing changes for the people and agents using the space. Going back afterwards means restoring that backup, not starting an older release: recent releases refuse to start on the upgraded database and say which upgrade they need, and older ones do not check, so never point one at it (DOR-2876)
