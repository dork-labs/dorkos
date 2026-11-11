---
covers:
  - 'fix(server): remote access refuses addresses with tricks like `..` in them, over both tunnels'
---

### Fixed

- Over Remote Access, an address written with a trick like `..` in it (for example `/x/../a2a`) could reach a page that is never meant to be reached from another device. Those addresses are now refused, over both your own ngrok tunnel and DorkOS's own remote access. Your own tunnel now also refuses the agent-to-agent pages, as DorkOS's remote access already did. Those pages always needed a key from another device, so nothing was open without one.
