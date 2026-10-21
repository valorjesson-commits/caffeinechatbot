# Snappy Chat

A Caffeine app whose chat UI talks to Caffeine Inference **directly from the
browser** — streamed completions, no canister in the request path.

## How it works

- **Backend (`src/backend/`)** — a Motoko canister with one job: credential
  brokering. `getInferenceCredentials` hands the platform-provisioned
  inference endpoint + API key to signed-in users so their browser can call
  the gateway itself. Completions never pass through the canister.
- **Frontend (`src/frontend/`)** — React/Vite chat UI. After Internet
  Identity sign-in it fetches the credentials, then POSTs to the gateway's
  OpenAI-compatible `/v1/chat/completions` with `model: "router"` and
  `stream: true`, rendering the reply token by token as SSE deltas arrive.
  Assistant replies are rendered as Markdown (GFM tables included); raw HTML
  in model output is never interpreted, so the renderer is XSS-safe. Each
  reply shows time-to-first-token and total latency.

## Security model

Handing the browser the app's inference key is a deliberate trade: any
signed-in user can extract it, so treat it as shared with your users. The
gateway scopes the key to this app (billing and spend caps apply there).
Mitigations in this app:

- credentials are only released to authenticated, registered principals via
  an update call, never to anonymous callers;
- grants are rate-limited per principal (30/hour);
- the backend reads the key from the canister environment on every call and
  never writes it to stable state, logs, or query responses;
- the frontend keeps the key in memory only — no localStorage, cookies, or
  URLs — and refreshes it via the backend if the platform rotates it (401/403
  triggers one refetch).

## Develop

```bash
pnpm install && caffeine install
caffeine build          # compiles backend, regenerates bindings, builds frontend
caffeine check --fix    # mops check + typecheck + biome
```

Browser-direct inference in dev (no replica needed): run any OpenAI-shaped
gateway locally, then

```bash
cd src/frontend
INFERENCE_PROXY_TARGET=http://localhost:9099 \
VITE_DEV_INFERENCE_KEY=<key> pnpm dev
```

Dev mode routes gateway calls through the Vite proxy (`/inference-proxy`);
production builds call the gateway origin directly (the gateway serves CORS
on `/v1/*`).

## Deploy

```bash
caffeine preview --build --project-id <id>
```
