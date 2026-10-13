---
covers:
  - 'perf(server): free the memory of Codex and OpenCode chats nobody is using (DOR-2897)'
---

### Fixed

- DorkOS uses less memory the longer it runs. Every Codex, OpenCode or Doe chat you opened stayed in memory until DorkOS restarted. Now a chat nobody has used for 10 to 20 minutes lets go of that memory, and comes back as normal when you open it again. Each chat's replay buffer is also half the size it was (DOR-2897)
