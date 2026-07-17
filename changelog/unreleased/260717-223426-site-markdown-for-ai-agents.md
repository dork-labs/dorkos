### Added

- AI tools can now ask any docs page for a markdown version: send `Accept: text/markdown` to a normal docs URL, or add a `.md` to the end (like `/docs/getting-started/quickstart.md`), and you get clean markdown instead of the full web page (DOR-345)
- A markdown sitemap at `/sitemap.md` gives agents one plain-text list of every docs, feature, blog, and marketplace page (DOR-345)
- New "Open in Perplexity" and "Open in Claude Desktop" shortcuts on docs pages, alongside the existing Claude, ChatGPT, Cursor, and Scira links (DOR-345)
- A `context7.json` file so DorkOS docs get indexed by Context7, a common docs source for coding agents (DOR-345)

### Changed

- Named every welcome AI crawler in `robots.txt` (OpenAI, Anthropic including Claude Code, Perplexity, and Meta) instead of relying on the catch-all rule, so each one has a clear, explicit invitation (DOR-345)
