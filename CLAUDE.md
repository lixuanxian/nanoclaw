# NanoClaw

Personal AI assistant. See [README.md](README.md) for philosophy and setup.

## Quick Context

Single Node.js process. Multi-channel with cross-channel sync (Web chat default; WhatsApp, Slack optional). All channels sharing the same folder sync to one conversation — AI sees all messages and broadcasts responses to every connected channel. Multi-AI provider (Claude auto-detected as default when CLI available; DeepSeek, MiniMax, QWEN, DOUBAO, OpenAI/Claude compatible). No AI provider required at startup — users can run first, configure later via Settings. Messages → SQLite → polling loop (folder-keyed) → agent containers. Groups are keyed by folder; multiple JIDs can share a folder for sync.

## Code Style

- **Max 500 lines per source file.** Split large files by functional area. Use barrel re-exports to preserve import paths when splitting.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: channel setup, subsystem wiring |
| `src/state.ts` | Runtime state, `loadState()`, `registerGroup()` |
| `src/message-loop.ts` | Message polling loop, `processGroupMessages()`, `runAgent()` |
| `src/providers.ts` | AI provider registry (7 providers) |
| `src/channel-config.ts` | Channel + AI config persistence (store/channel-config.json) |
| `src/web-server.ts` | Hono HTTP server, WebSocket, auth, static SPA serving |
| `src/web-api.ts` | REST API handlers (channels, AI config, sessions, files) |
| `web/` | React + Ant Design SPA (esbuild build) |
| `src/channels/web.ts` | Web channel (browser chat via WebSocket) |
| `src/channels/slack.ts` | Slack channel (Socket Mode) |
| `src/channels/dingtalk.ts` | DingTalk channel (Stream mode) |
| `src/router.ts` | Message formatting, outbound routing, `broadcastToFolder()` |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Container runtime detection, orphan cleanup |
| `src/container-mounts.ts` | Container volume mount configuration |
| `src/container-snapshots.ts` | Task/group snapshot files for containers |
| `src/mount-security.ts` | Mount path allowlist validation |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | Barrel: re-exports all SQLite operations |
| `src/db-init.ts` | Database setup, schema, migrations |
| `src/db-messages.ts` | Message CRUD operations |
| `src/db-tasks.ts` | Task CRUD operations |
| `src/db-groups.ts` | Chat metadata, sessions, registered groups |
| `src/logger.ts` | Pino logger setup |
| `src/env.ts` | `.env` file reader |
| `src/whatsapp-auth-flow.ts` | WhatsApp QR auth flow |
| `container/agent-runner/src/index.ts` | Container entrypoint, provider routing |
| `container/agent-runner/src/claude-query.ts` | Claude Agent SDK query loop, IPC message handling |
| `container/agent-runner/src/transcript.ts` | Session transcript parsing and archival |
| `container/agent-runner/src/openai-agent.ts` | OpenAI-compatible agent loop |
| `container/agent-runner/src/anthropic-agent.ts` | Claude-compatible agent loop |
| `container/agent-runner/src/tools.ts` | Agent tool definitions |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP stdio IPC bridge |

## AI Provider Architecture

Resolution chain: `group.containerConfig → Settings page default → env vars → claude (if CLI available) → none (user must configure)`.

Container agent paths:
- `claude` → Claude Agent SDK (`query()`)
- `claude-compatible` → `anthropic-agent.ts` (Anthropic Messages API)
- All others → `openai-agent.ts` (OpenAI chat completions API)

Env vars: `AI_API_BASE`, `AI_DEFAULT_MODEL` (generic); `{PROVIDER}_API_BASE`, `{PROVIDER}_DEFAULT_MODEL` (per-provider). Settings page overrides env vars.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream changes, merge with customizations |

## Development

```bash
npm run dev          # Run backend with hot reload
npm run build        # Compile backend + frontend
npm run build:web    # Build React SPA only
npm run dev:web      # Watch-mode frontend rebuild
./container/build.sh # Rebuild agent container
```

## Container Build Cache

The container buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a clean rebuild, prune the builder then re-run `./container/build.sh`.
