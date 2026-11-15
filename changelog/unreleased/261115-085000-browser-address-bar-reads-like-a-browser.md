---
covers:
  - 'feat(client): the browser address bar reads what you type the way a browser does (DOR-4419)'
---

### Changed

- The address bar in the Agent browser and the canvas browser now reads what you type the way a browser does. Words become a DuckDuckGo search, `example.com` opens over https (and tries plain http once if that can't connect), and `localhost:3000` or a home-network address opens over plain http.
- Typing something that can't open there, like a file or a `javascript:` link, now shows one short line saying why, and keeps what you typed so you can fix it.
