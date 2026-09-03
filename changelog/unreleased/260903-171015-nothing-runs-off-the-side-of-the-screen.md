---
covers:
  - 'fix(client): the workspaces folder stays inside its card (DOR-1747)'
  - 'fix(client): a package card shows its author and its source whole (DOR-1747)'
  - "fix(client): an agent's name outlives the path beside it (DOR-1747)"
  - 'fix(client): the font choice ellipsises instead of clipping mid-word (DOR-1747)'
  - 'fix(client): the marketplace search reads in full on a phone (DOR-1747)'
  - 'fix(client): four more places where text left its box (DOR-1747)'
  - 'test(e2e): nothing escapes its container at 390px (DOR-1747)'
---

### Fixed

- Long folder paths stay inside the card that shows them. On a phone, the Workspaces page used to push yours off the side of the screen (DOR-1747)
- Marketplace cards show who made a package and where it came from, in full. On a narrow card the two facts now sit on two lines instead of being cut to a letter each (DOR-1747)
- An agent's name stays readable in search results. The folder path beside it gives way first (DOR-1747)
- The marketplace search box fits on a phone. The "/" shortcut hint it was making room for only shows where there is a keyboard to press it (DOR-1747)
- Text no longer paints outside its box in the font picker, the blocked-paths list, chat error details, or the full-power window (DOR-1747)
