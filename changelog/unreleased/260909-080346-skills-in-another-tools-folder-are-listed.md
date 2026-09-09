---
covers:
  - "feat(harness): another tool's skills and MCP files are named (DOR-1902)"
  - "feat(server,client): another tool's skill is an adoptable row (DOR-1902)"
  # Folds in here: it corrects the two bullets above before either has shipped,
  # so there is nothing a person could have seen go wrong.
  - 'fix(harness): a real parser counts MCP servers, and links there are yours (DOR-1902)'
  # Same fold: the reader met DOR-1882's file-where-a-folder-belongs shape at rebase.
  - 'fix(harness): a file where .codex belongs no longer throws out of the MCP read (DOR-1902)'
---

### Added

- Skills that only live in another agent tool's folder now show up. `.opencode/skills`, `.cursor/skills`, `.gemini/skills`, `.github/skills` and `.codex/skills` are read alongside your own, so a project whose skills live in one of them sees them on the Skills page and in `dorkos harness sync` instead of an empty list. Each one says which tools read it where it is, which do not, and says to move it somewhere every tool can read — it is a sentence, not a button, and nothing is moved for you (DOR-1902)
- An MCP server list in another tool's config file is named as something DorkOS does not carry. If your servers are declared in `opencode.json`, `.codex/config.toml` or `.cursor/mcp.json`, you now get one line saying how many are in there and that DorkOS only passes on the ones in `.mcp.json`. It counts them and reads nothing else, so nothing from those files — no server name, no key — is ever printed or stored. Every ordinary way of writing that list is counted the same, including the shorthand forms, and a file your editor saved with a byte-order mark is read rather than called broken (DOR-1902)

### Changed

- The advice on a skill that only some of your agents can see now names the folder it is really in, instead of always saying `.claude/skills` (DOR-1902)
