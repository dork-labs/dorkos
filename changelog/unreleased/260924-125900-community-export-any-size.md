---
covers:
  - 'feat(community): export a community of any size in the background (DOR-2295)'
  - 'fix(community): close the husk export race and share the export worker fairly (DOR-2295)'
  - 'fix(community): time exports by work done and step aside only for a runnable export (DOR-2295)'
  - 'fix(community): keep the export download button inside its panel on narrow columns (DOR-2295)'
  - 'fix(community): stop the hidden icon picker from widening the settings page (DOR-2295)'
---

### Changed

- Community exports now work at any size. Choosing **Export this community** or **Download my data** starts the export in the background, and a progress bar shows how far it has got. You can close the page and come back. When it is ready, **Download** shows the file's size, the export is kept for a day, and a download that stops can resume from your browser's downloads list. Before, a community with more than 10,000 messages or members, or more than 1 GB of files, could not be exported at all.
- The exported `.zip` now also holds the community's name, description, joining rule, icon, and who is in each channel, and marks messages that were deleted or erased. Messages posted after an export starts are not included, and a message deleted while an export is prepared is left out or shown as deleted.
