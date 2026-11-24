---
covers:
  - 'fix(copy): say network, not Wi-Fi, for devices that reach this computer (DOR-5135)'
  - 'fix(lan-access): let devices on the same Tailscale network in (DOR-5135)'
---

### Changed

- The switch that lets other devices open DorkOS on this computer now reads **Let devices on my network in**, and the app and docs say "network" instead of "Wi-Fi" for it. It works for computers plugged in by cable too, and advice like "Check you're on the same Wi-Fi" now says "network or VPN". What a device on your network can do has not changed (DOR-5135).

### Fixed

- Devices on your Tailscale network can now open DorkOS through that switch, from anywhere. Open the address that starts with `100.` from the list in Settings. Before, the computer turned away their `100.` addresses (DOR-5135).
