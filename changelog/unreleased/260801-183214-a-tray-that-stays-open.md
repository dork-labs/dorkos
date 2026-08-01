---
covers:
  - 'fix(chat): a chip tray you opened stays open when the turn finishes (DOR-827)'
  - 'fix(client): the working breath fades without growing (DOR-828)'
  - 'fix(client): clicking a touch chip actually shows you the canvas (DOR-829)'
  - 'fix(client): a tray keeps the whole arrangement you gave it (DOR-827, DOR-829)'
---

### Fixed

- **Click a file or page your agent touched and it opens where you can see it.** The chips under a reply are meant to be a way in: press one, and the file or page opens in the panel beside the chat. The panel was not being opened, so the file loaded into a panel that stayed shut — nothing appeared to happen unless you knew to open the side panel yourself and go looking. Now a chip opens the panel, switches to it, and shows you the thing you pressed. The same was true of the fullscreen button on an interactive app from an MCP server, and is fixed with it. Chips with nothing single to open — a command, a search, a file pattern — still do nothing at all, which is the honest answer for them (DOR-829).

- **Open the list of everything a turn touched, and it stays exactly as you left it when the turn finishes.** While an agent works, the strip under its reply shows the last few files, pages and commands it handled, and you can open the pile to see the whole list — narrowed to just the edits, say, and in the order things happened. All of that used to be thrown away the moment the turn ended: the list shut, the filter dropped, the order sprang back. Usually right as you were reading it, because the turn ending is what makes the list worth reading. Now the list stays open, filtered and sorted the way you set it, until you say otherwise (DOR-827).

- **The "working" pulse fades instead of also growing.** The soft pulse on thinking text, loading placeholders and status dots was nudging each element about 2% larger and back, over and over. It was barely visible and never worth the wobble on a line of text, so it is now a pure fade — the same quiet signal, on something that sits still (DOR-828).
