# DorkOS

[![npm version](https://img.shields.io/npm/v/dorkos)](https://www.npmjs.com/package/dorkos)
[![license](https://img.shields.io/npm/l/dorkos)](LICENSE)

Web-based interface and REST/SSE API for Claude Code, built with the Claude Agent SDK.

## What is DorkOS?

DorkOS gives Claude Code a browser-based chat UI with tool approval flows, slash command discovery, and cross-client session synchronization. It wraps the Claude Agent SDK with a REST/SSE API that any client can consume.

## Install

```bash
npm install -g dorkos
```

## Quick Start

```bash
export ANTHROPIC_API_KEY=your-key-here
dorkos
```

The server starts on port 4242 and opens your browser automatically.

<!-- TODO: Add screenshot or GIF of the UI -->

## Features

- Chat UI with rich markdown rendering and syntax highlighting
- Tool approval and deny flows for safe AI interactions
- Slash command discovery from `.claude/commands/`
- Real-time SSE streaming responses
- Cross-client session sync (CLI, web, Obsidian)
- Marketing website and documentation site ([dorkos.ai](https://dorkos.ai))
- Obsidian plugin with sidebar integration
- ngrok tunnel support for remote access
- Interactive API documentation at `/api/docs` (OpenAPI 3.1)
- Working directory picker for project context

## Documentation

Full documentation is available at [dorkos.ai/docs](https://dorkos.ai/docs) and in the [`contributing/`](contributing/) directory:

- [Architecture Overview](contributing/architecture.md) - Hexagonal architecture, Transport interface, module layout
- [API Reference](contributing/api-reference.md) - OpenAPI spec, endpoints, SSE streaming protocol
- [Design System](contributing/design-system.md) - Color palette, typography, spacing, motion specs
- [Obsidian Plugin Development](contributing/obsidian-plugin-development.md) - Plugin architecture and development guide
- [Interactive Tools](contributing/interactive-tools.md) - Tool approval flows and interactive patterns

See [CLAUDE.md](CLAUDE.md) for comprehensive technical documentation.

## Development

```bash
git clone https://github.com/dork-labs/dorkos.git
cd dorkos
npm install
cp .env.example .env  # Add your ANTHROPIC_API_KEY
npm run dev
```

This starts the Express server on port 4242 and the Vite dev server on port 5173.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our development process, coding standards, and how to submit pull requests.

## License

[MIT](LICENSE)
