---
covers:
  - 'fix(desktop): ship the ngrok binary Remote Access needs (#1458)'
---

### Fixed

- Remote Access now works in the Mac app. Turning it on always failed — the switch flicked straight back off, no matter which ngrok token you used. The part of ngrok that does the real work was missing from the app we shipped, so the attempt died in a few thousandths of a second, before anything reached the internet; nothing you could change in settings would have helped. That part now ships with the app, and the Windows build is wired the same way. (#1458)
