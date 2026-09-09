---
covers:
  - 'fix(harness): an inventory warning says what is wrong, not which errno (DOR-1938)'
  - 'fix(harness,server): a skill folder DorkOS cannot open is a warning, not a missing skill (DOR-1949)'
  - 'fix(harness,server,cli): a folder a sweep could not look inside is said out loud (DOR-1939)'
  - 'fix(harness): a removal DorkOS may not make is not promised, and never throws (DOR-1941)'
  - 'fix(harness): a native claim whose link is blocked is a drop, not a promise (DOR-1942)'
  - 'fix(harness): a global plan names the folder that is really in the way (DOR-1937)'
---

### Fixed

- A skill in a folder DorkOS cannot open is now reported instead of quietly vanishing. Before, a folder with the wrong permissions on it made a project with a skill in it look exactly like a project with none — and `dorkos harness adopt <name>` told you there was no skill by that name, which was not true about your own project. You now get a warning naming the folder, and asking to move the skill tells you what to fix (DOR-1949)
- Warnings about files DorkOS could not read are written in plain words again. They used to trail off into an error code and somebody's home directory — `ENOTDIR: not a directory, scandir '/Users/…'`. Now they say what is actually wrong: it is a file, not a folder; nobody may read it; the link points at nothing (DOR-1938)
- `dorkos harness sync` now tells you when it could not look inside a folder it tidies up. It used to say the project was fully in sync, because a folder it could not open and an empty folder looked the same to it. Nothing was ever deleted by mistake — it is a warning, not a fault — but you can now see the folder and fix it (DOR-1939)
- A sync no longer promises to remove a file it cannot remove. If an old, unused link sits in a folder DorkOS may not write in, `--check` used to list it for removal and `--fix` then stopped partway through with a permission error. Both now name the folder and leave everything exactly where it is (DOR-1941)
- The report no longer claims a coding tool can see a packaged skill when the link it reads could not be made. If something is in the way of `.agents/skills`, the skill is listed as not reaching that tool, with the folder that is in the way named — instead of being shown as working (DOR-1942)
- When DorkOS cannot read one of the folders your all-projects packages use, the message names the folder that is actually in the way. It used to blame the packages folder whichever of the two was the problem, and print an error code about the other one (DOR-1937)
