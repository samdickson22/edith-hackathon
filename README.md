# Edith — AI Assistant for Smart Glasses

**Multimodal Frontier Hackathon 2026**

Edith turns your smart glasses into a hands-free AI assistant powered by OpenClaw. Say "Hey Edith" and talk to your personal AI agent — complete with memory, tools, vision, and knowledge search — all through your glasses.

## Demo

[3-minute demo video link]

## What it does

- **Voice AI** — Say "Hey Edith" followed by any question. She responds through the glasses speakers.
- **Vision** — "What am I looking at?" triggers the glasses camera and sends the image to your AI agent.
- **Knowledge Search** — Powered by Senso.ai, ask "What does our policy say about..." to search your knowledge base hands-free.
- **API Key Security** — Powered by Unkey, the WebSocket relay verifies API keys for secure multi-user access.
- **Full Agent Access** — Edith is an OpenClaw channel, so your agent's full toolset (browser, code execution, memory, integrations) is available through voice.

## Architecture

```
Glasses → Edith App (DigitalOcean) → WebSocket → OpenClaw Plugin (your machine) → AI Agent → Response → TTS → Glasses
```

The OpenClaw plugin connects **outbound** to the hosted Edith app — no port forwarding or tunnels needed. It works like Discord and Telegram channel plugins.

### Components

| Component | Description |
|-----------|-------------|
| `app/` | Mentra SDK app server — handles wake word detection, transcription, camera, TTS, and WebSocket relay |
| `plugin/` | OpenClaw channel plugin — receives messages via WebSocket, dispatches through the agent pipeline |
| `app/skills/` | OpenClaw skills for Senso.ai and Unkey integrations |
| `plugin/skills/` | Setup skill that automates plugin installation and configuration |

## Sponsor Integrations

### Senso.ai — Knowledge Search
Edith can search and ingest documents through Senso.ai's knowledge base API. Ask a question and get grounded, verified answers spoken through your glasses.

- `npx shipables install samdickson22/edith-senso-knowledge`
- `npx shipables install samdickson22/edith-senso-ingest`

### Unkey — API Key Auth
The WebSocket relay uses Unkey to verify API keys, providing rate limiting and usage analytics for multi-user deployments.

- `npx shipables install samdickson22/edith-api-keys`

### DigitalOcean
Deployed infrastructure for the relay server.

## Setup

### For users

1. Install the Edith app from the Mentra app store on your glasses
2. Install the setup skill:
   ```
   npx shipables install samdickson22/edith
   ```
3. Tell OpenClaw: "Set up my Edith glasses with your edith skill. My code is XXXXXXXX"

### For developers

```bash
# App server
cd app
bun install
PACKAGE_NAME=com.edith.glasses MENTRAOS_API_KEY=your-key bun run dev

# Plugin (install into OpenClaw)
cd plugin
openclaw plugins install .
```

## Tech Stack

- **Runtime**: Bun + TypeScript
- **Glasses SDK**: @mentra/sdk
- **AI Backend**: OpenClaw (self-hosted AI gateway)
- **Knowledge**: Senso.ai REST API
- **Auth**: Unkey API key management
- **Hosting**: DigitalOcean App Platform
- **WebSocket**: ws (relay between glasses and OpenClaw)

## Published Skills (Shipables.dev)

- [`samdickson22/edith`](https://codeables.dev/skills/samdickson22/edith) — Setup wizard
- [`samdickson22/edith-senso-knowledge`](https://codeables.dev/skills/samdickson22/edith-senso-knowledge) — Senso.ai search
- [`samdickson22/edith-senso-ingest`](https://codeables.dev/skills/samdickson22/edith-senso-ingest) — Senso.ai ingest
- [`samdickson22/edith-api-keys`](https://codeables.dev/skills/samdickson22/edith-api-keys) — Unkey key management

## npm Package

- [`openclaw-edith-glasses`](https://www.npmjs.com/package/openclaw-edith-glasses) — OpenClaw channel plugin

## License

MIT
