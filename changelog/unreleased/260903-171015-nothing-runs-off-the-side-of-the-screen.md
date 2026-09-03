---
covers:
  - 'fix(client): the workspaces folder stays inside its card (DOR-1747)'
  - 'fix(client): a package card shows its author and its source whole (DOR-1747)'
  - "fix(client): an agent's name outlives the path beside it (DOR-1747)"
  - 'fix(client): the font choice ellipsises instead of clipping mid-word (DOR-1747)'
  - 'fix(client): the marketplace search reads in full on a phone (DOR-1747)'
  - 'fix(client): four more places where text left its box (DOR-1747)'
  - 'test(e2e): nothing escapes its container at 390px (DOR-1747)'
  - "fix(client): a package card's floor never asks for more than the card has (DOR-1747)"
  - 'fix(e2e): the overflow probe sees wrapper escapes and inline text, and knows when it saw nothing (DOR-1747)'
  - "fix(client): a connector tile's name row stays inside the card (DOR-1747)"
  - 'fix(client): a truncated candidate name and denial reason keep their value on hover (DOR-1747)'
  - 'fix(client): the marketplace search placeholder fits under 390px too (DOR-1747)'
---

### Fixed

- Long folder paths stay inside the card that shows them. On a phone, the Workspaces page used to push yours off the side of the screen (DOR-1747)
- Marketplace cards show who made a package and where it came from, in full, on a card of any width — including the narrow columns a docked panel or a half-width window can create (DOR-1747)
- An agent's name stays readable in search results. The folder path beside it gives way first (DOR-1747)
- The marketplace search box fits on a phone, down to the smallest ones — the "/" shortcut hint it was making room for only shows where there is a keyboard to press it (DOR-1747)
- Text no longer paints outside its box in the font picker, the blocked-paths list, the discovered-agent list, a connector tile's name, chat error details, or the full-power window (DOR-1747)
- A discovered agent's suggested name and a denied agent's reason now show their full value on hover when truncated, matching every other truncated field (DOR-1747)
