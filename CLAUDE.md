# NanoClaw

Personal AI assistant with container-isolated agents. See [README.md](README.md).

## Quick Context

Single Node.js process. Multi-channel with cross-channel sync (Web default; WhatsApp, Slack, DingTalk optional). All channels sharing a folder sync to one conversation. Multi-AI provider (Claude auto-detected when CLI available; DeepSeek, MiniMax, QWEN, DOUBAO, OpenAI/Claude compatible). No AI provider required at startup — configure later via Settings. Messages → SQLite → polling loop (folder-keyed) → agent containers.

## Code Style

- **Max 500 lines per source file.** Split by functional area. Barrel re-exports to preserve imports.

## Key Files

### Host — Core

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: channel setup, subsystem wiring |
| `src/state.ts` | Runtime state, `loadState()`, `registerGroup()` |
| `src/message-loop.ts` | Message polling, `processGroupMessages()`, `runAgent()` |
| `src/providers.ts` | AI provider registry |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/types.ts` | TypeScript interfaces |
| `src/channel-config.ts` | Channel + AI config persistence |

### Host — Web & API

| File | Purpose |
|------|---------|
| `src/web-server.ts` | Hono HTTP server, WebSocket, auth, static SPA |
| `src/web-api.ts` | REST API handlers (channels, AI config, sessions) |
| `src/web-api-files.ts` | File browser API |
| `src/web-api-groups.ts` | Group management API |
| `src/web-api-logs.ts` | Log viewer API |
| `src/web-api-cleanup.ts` | Cleanup API |

### Host — Channels

| File | Purpose |
|------|---------|
| `src/channels/web.ts` | Web channel (WebSocket) |
| `src/channels/whatsapp.ts` | WhatsApp channel (Baileys) |
| `src/channels/slack.ts` | Slack channel (Socket Mode) |
| `src/channels/dingtalk.ts` | DingTalk channel (Stream) |

### Host — Container & Infrastructure

| File | Purpose |
|------|---------|
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Runtime detection, orphan cleanup |
| `src/container-mounts.ts` | Volume mount configuration |
| `src/container-snapshots.ts` | Task/group snapshot files |
| `src/mount-security.ts` | Mount path allowlist validation |
| `src/router.ts` | Message formatting, outbound routing |
| `src/group-queue.ts` | Per-group queue with concurrency limit |
| `src/task-scheduler.ts` | Scheduled task execution |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/skills.ts` | Skills system integration |

### Host — Database

| File | Purpose |
|------|---------|
| `src/db.ts` | Barrel: re-exports all DB operations |
| `src/db-init.ts` | Schema, migrations |
| `src/db-messages.ts` | Message CRUD |
| `src/db-tasks.ts` | Task CRUD |
| `src/db-groups.ts` | Chat metadata, sessions, groups |

### Container Agent

| File | Purpose |
|------|---------|
| `container/agent-runner/src/index.ts` | Entrypoint, provider routing |
| `container/agent-runner/src/claude-query.ts` | Claude Agent SDK query loop |
| `container/agent-runner/src/anthropic-agent.ts` | Claude-compatible agent (Anthropic API) |
| `container/agent-runner/src/openai-agent.ts` | OpenAI-compatible agent |
| `container/agent-runner/src/tools.ts` | Agent tool definitions |
| `container/agent-runner/src/transcript.ts` | Session transcript handling |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP stdio IPC bridge |

### Frontend (`web/`)

React 19 + Ant Design 6 SPA (esbuild). Pages: Chat, Settings, Login. Key components: MessageList, MessageInput, GroupList, AgentList, TaskList, FileBrowser, LogViewer, SearchPopover, SkillsTab, WorkspaceTab.

## AI Provider Architecture

Resolution: `group.containerConfig → Settings page → env vars → claude (if CLI available) → none`.

Agent paths:
- `claude` → Claude Agent SDK (`query()`)
- `claude-compatible` → `anthropic-agent.ts` (Anthropic Messages API)
- All others → `openai-agent.ts` (OpenAI chat completions API)

Env vars: `AI_API_BASE`, `AI_DEFAULT_MODEL` (generic); `{PROVIDER}_API_BASE`, `{PROVIDER}_DEFAULT_MODEL` (per-provider).

## Skills

| Skill | Purpose |
|-------|---------|
| `/setup` | First-time installation and configuration |
| `/customize` | Add channels, integrations, change behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream changes, merge customizations |

## Development

```bash
npm run dev          # Backend + frontend with hot reload
npm run build        # Compile all
npm run build:web    # Build React SPA only
npm run dev:web      # Watch-mode frontend
./container/build.sh # Rebuild agent container
npm test             # Run tests
```

## Container Build Cache

Buildkit caches aggressively. `--no-cache` alone doesn't invalidate COPY steps. To force clean rebuild: `docker builder prune -af && ./container/build.sh`.
