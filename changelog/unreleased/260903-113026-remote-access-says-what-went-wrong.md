---
covers:
  - 'fix(client): Remote Access says what actually went wrong (DOR-1739)'
  - 'fix(client): a toggle that failed stops suppressing the next real toast (DOR-1739)'
  - 'fix(client): a reconnecting tunnel reads as on, not as off (DOR-1739)'
---

### Fixed

- Fixed a bug where turning on Remote Access looked like it did nothing: when the tunnel failed to start, the reason flashed on screen for an instant and then vanished, taking the "Try again" button with it. The switch simply snapped back off. The failure now stays on screen until you dismiss it (DOR-1739)
- Fixed a bug where saving your ngrok token always said "Could not save token. Try again." no matter what happened. DorkOS now tells you the real reason, and says what to do about it when the save was turned down (DOR-1739)
- Fixed a bug where a custom domain that failed to save said nothing at all, leaving your typed domain sitting in the box as though it had been saved (DOR-1739)
- Fixed a bug where clicking into the custom domain box and back out again could erase a domain you had already saved (DOR-1739)
- Fixed a bug where a tunnel that took more than 15 seconds to start was reported as timed out, and then reported as connected a few seconds later when it worked (DOR-1739)
- Fixed a bug where turning Remote Access off yourself raised a red warning saying DorkOS was "attempting to reconnect". Turning it off is now silent. A tunnel that drops on its own says so plainly, and only says "reconnecting" when ngrok really is putting it back (DOR-1739)
- Fixed a bug where a tunnel that was briefly re-establishing itself showed as switched off, with your address gone. It now stays on and says "Reconnecting", and switching it on again while it is already running no longer reports a failure over a tunnel that is working (DOR-1739)
- Fixed a bug where the connected tunnel's speed check kept firing at an unreachable address with nothing to stop it, piling up requests for as long as the window stayed open (DOR-1739)
- The Remote Access setup note said to create your owner login first; it is the token first, and the login when you switch remote access on. The note now matches (DOR-1739)
