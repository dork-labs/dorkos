---
covers:
  - 'feat(server): a Wi-Fi sign-in can chat and read, but not change how DorkOS is reached (DOR-2969 part 3)'
  - 'fix: from Wi-Fi an approval is Allow once or Deny, never Always allow (DOR-2969 part 3)'
  - 'fix(server): from Wi-Fi a teammate spending limit is set only at this computer (DOR-2969 part 3)'
---

### Security

- A phone or laptop signed in over Wi-Fi can chat, read, and answer approvals, but it can't open the terminal, edit files directly, see or make API keys, install packages or extensions, reset DorkOS, change a spending limit, or sign out your other devices. When an agent asks, it can Allow once or Deny, but never Always allow, and it can't allow a destructive action. It can still ask your agents to do anything they can do. Those stay on the computer DorkOS runs on, and the app says so plainly when you try. (DOR-2969)
- Changing how DorkOS is reached now happens only in the app on the computer it runs on, by its owner: remote access, Wi-Fi access, the password setting, accounts and keys, and which code DorkOS runs. API keys and agents can't change these either. (DOR-2969)
