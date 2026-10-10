---
covers:
  - 'feat(onboarding): a one-minute first run that lands in #team (DOR-2783)'
---

### Changed

- A new DorkOS starts with one screen and one button: **Continue with DorkOS**. It opens your browser to sign in with the code already filled in, then moves on by itself once your account is ready. No setup check, no list of AI apps to pick from (DOR-2783)
- Rather use your own AI? **Use my own AI** lists every way in, one row each: an OpenAI, Anthropic or OpenRouter key, a model on your own computer, an AI app you already sign in to, or any other service. Paste a key and DorkOS picks the model (DOR-2783)
- Every path ends in #team, where DorkBot says hello and offers a first job: **Build me a tracker for my customers**, **Make a daily plan board**, or **Something else**. One press, and DorkBot starts on it. Skipped the account? The same spot offers the two ways to connect AI instead (DOR-2783)

### Removed

- The old first run is gone: the setup scan, the power-level step and the scripted chat with DorkBot. Set your name and the kind of work you do in Settings › Profile. Full power is still offered the first time an agent needs it (DOR-2783)
