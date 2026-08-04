# AI Interpreter Workbench — Frontend

Vite + React 19 + TypeScript SPA. Placeholder app shell for now; screens for
Realtime and Cascade interpretation modes land in later issues.

## Setup

```bash
npm install
```

## Run (dev)

```bash
npm run dev
```

Serves on `http://localhost:5173`. Requires the backend running on
`http://localhost:5170` (see `backend/README` or root `README.md`) — `/api`,
`/healthz`, and `/ws` are proxied there by Vite (`vite.config.ts`) so the SPA
never needs CORS configuration or a hardcoded base URL.

## Test

```bash
npm test
```

## Build

```bash
npm run build
```

## Conventions

- All backend calls go through `src/api.ts` — components never call `fetch`
  directly.
- Tests live under `src/__tests__/`, not alongside source files.
