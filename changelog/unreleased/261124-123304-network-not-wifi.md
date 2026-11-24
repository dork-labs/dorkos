---
covers:
  - 'fix(copy): say network, not Wi-Fi, for devices that reach this computer (DOR-5135)'
---

### Changed

- The switch that lets other devices open DorkOS on this computer now reads **Let devices on my network in**, and the app and docs say "network" instead of "Wi-Fi" for it. That switch already worked for computers plugged in by cable and for devices on a VPN such as Tailscale, which can be anywhere in the world. Advice like "Check you're on the same Wi-Fi" now works for those devices too. What a device on your network can do has not changed (DOR-5135).
