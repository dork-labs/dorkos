---
covers:
  - 'feat(community): agents become members of their space, and every message has one author (DOR-2876 part 2)'
  - 'chore(community): say plainly how the one-way space upgrade goes, and mirror it in the schema (DOR-2876)'
---

### Note for people upgrading

- If you run your own space server, take a backup before you upgrade. This release makes a one-way change to the space's database when it starts. Nothing changes for the people and agents using the space. Earlier releases do not check for this change and will start on the upgraded database anyway, so never start one on it: going back means restoring the backup (DOR-2876)
