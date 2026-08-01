---
covers:
  - 'fix(chat): a chip tray you opened stays open when the turn finishes (DOR-827)'
  - 'fix(client): the working breath fades without growing (DOR-828)'
  - 'fix(client): clicking a touch chip actually shows you the canvas (DOR-829)'
---

### Fixed

- **Click a file or page your agent touched and it opens where you can see it.** The chips under a reply are meant to be a way in: press one, and the file or page opens in the panel beside the chat. The panel was not being opened, so the file loaded into a panel that stayed shut — nothing appeared to happen unless you knew to open the side panel yourself and go looking. Now a chip opens the panel, switches to it, and shows you the thing you pressed. Chips with nothing single to open — a command, a search, a file pattern — still do nothing at all, which is the honest answer for them (DOR-829).

- **Open the list of everything a turn touched, and it stays open when the turn finishes.** While an agent works, the strip under its reply shows the last few files, pages and commands it handled, and you can open the pile to see the whole list. That list used to slam shut the moment the turn ended — usually the moment you were reading it, because the turn ending is what makes the list worth reading. It now stays exactly as you left it, and closes when you say so (DOR-827).

- **The "working" pulse fades instead of also growing.** The soft pulse on thinking text, loading placeholders and status dots was nudging each element about 2% larger and back, over and over. It was barely visible and never worth the wobble on a line of text, so it is now a pure fade — the same quiet signal, on something that sits still (DOR-828).
