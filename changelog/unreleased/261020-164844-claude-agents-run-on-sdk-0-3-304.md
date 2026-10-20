### Changed

- Agents set to Sonnet or Haiku now run on Sonnet 5.5 and Haiku 5.5. Opus and Fable are unchanged.
- Claude Code agents now run on Agent SDK 0.3.304.
- A helper agent that a Claude Code agent starts can now begin with a copy of the chat so far. This is on by default, and it uses more of the context window.

### Note for people upgrading

- Sonnet 5.5 and Haiku 5.5 always think a little before they answer, even when thinking is set to None.
