---
covers:
  - 'fix(desktop,server): the app window says no by default, and its page cannot load code from the internet (DOR-560)'
---

### Fixed

- The desktop app never told its window what it was allowed to ask your computer for, and a window that says nothing is treated as saying yes. Camera, microphone, location and reading your clipboard could all be handed over without a prompt you would ever see. Now everything is refused except the two things the app really does: show you a notification, and copy text you asked it to copy. Even those are refused to anything that is not DorkOS itself, like a website you have open in a canvas (DOR-560)
- The page the app runs on can call everything your agents can. It now carries a rule about where its code may come from: your own machine, and nowhere else. Nothing an agent writes into a message, a widget or a marketplace card can pull a script off the internet and run it there. Everything you already use works exactly as before, including 3D and PDF previews, embedded web pages and copy buttons; we checked each one in a real browser (DOR-560)
