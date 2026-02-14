# DorkOS

Web-based interface and channel-agnostic REST/SSE API for Claude Code, powered by the Claude Agent SDK.

## Prerequisites

- Node.js 20+
- npm

## Quick Start

```bash
cd gateway
npm install
npm run dev
```

This starts:
- **Express server** on `http://localhost:6942` (API + SSE)
- **Vite dev server** on `http://localhost:5173` (React UI with HMR)

## Development

```bash
npm run dev          # Start both server and client
npm run dev:server   # Server only (tsx watch)
npm run dev:client   # Client only (Vite)
npm run test         # Run tests in watch mode
npm run test:run     # Run tests once
```

## Production

```bash
npm run build        # Build client (Vite) + compile server (tsc)
npm start            # Start production server
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health check |
| POST | `/api/sessions` | Create new session |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/:id` | Get session details |
| DELETE | `/api/sessions/:id` | Delete session |
| POST | `/api/sessions/:id/messages` | Send message (SSE stream response) |
| POST | `/api/sessions/:id/approve` | Approve pending tool call |
| POST | `/api/sessions/:id/deny` | Deny pending tool call |
| GET | `/api/commands` | List slash commands |
| GET | `/api/commands?refresh=true` | Refresh and list commands |

## Architecture

```
gateway/
├── src/
│   ├── server/           # Express API server
│   │   ├── index.ts      # Server entry point
│   │   ├── routes/       # API route handlers
│   │   ├── services/     # Business logic (agent manager, session store, etc.)
│   │   └── middleware/    # Error handler
│   ├── client/           # React 19 + Vite frontend
│   │   ├── App.tsx       # Root layout
│   │   ├── components/   # UI components (chat, sessions, commands, layout)
│   │   ├── hooks/        # Custom hooks (useChatSession, useCommands, useSessions)
│   │   ├── stores/       # Zustand state management
│   │   └── lib/          # API client, utilities
│   └── shared/           # Types shared between server and client
├── package.json
├── tsconfig.json         # Base TypeScript config
├── tsconfig.server.json  # Server-specific config
└── vite.config.ts        # Vite + React + Tailwind config
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_PORT` | `6942` | Port for the Express server |
| `NODE_ENV` | `development` | Environment mode |

## Key Technologies

- **Backend**: Express, Claude Agent SDK, SSE streaming
- **Frontend**: React 19, Vite 6, TypeScript, Tailwind CSS 4, shadcn/ui
- **State**: Zustand (client state), TanStack Query (server state)
- **Testing**: Vitest, React Testing Library
