---
covers:
  - 'fix(connectors): show a popular app once when it connects through Nango (DOR-2436)'
  - 'fix(connectors): move every saved Nango account to its app and keep the app’s row stable (DOR-2436)'
---

### Fixed

- A popular app you set up on your own Nango server, like Gmail, now shows up once in Connections, as that app with its name, logo and description, and you can connect it right there. Before, it showed twice: once as the popular app with no way to connect, and again under the key you gave it in Nango. Accounts you already connected, including disconnected ones, move to the right app too. If you set up the same app twice in Nango, the one you set up first keeps the app's row (DOR-2436)
