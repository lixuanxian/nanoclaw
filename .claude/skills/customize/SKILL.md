---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

Use AskUserQuestion to understand the request, then make changes directly to the code.

## Workflow

1. **Understand** - Ask clarifying questions
2. **Plan** - Identify files to modify
3. **Implement** - Make changes
4. **Verify** - Tell user how to test

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: channel setup, subsystem wiring |
| `src/state.ts` | Runtime state, `loadState()`, `registerGroup()` |
| `src/message-loop.ts` | Message polling, `processGroupMessages()`, `runAgent()` |
| `src/providers.ts` | AI provider registry (7 providers) |
| `src/channel-config.ts` | Channel + AI config persistence, provider resolution |
| `src/web-server.ts` | Hono HTTP server, WebSocket, auth, UI routes |
| `src/web-api.ts` | REST API handlers |
| `src/channels/web.ts` | Web channel (browser chat via WebSocket) |
| `src/channels/slack.ts` | Slack channel (Socket Mode) |
| `src/router.ts` | Message formatting, outbound routing |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/types.ts` | TypeScript interfaces (includes Channel) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | Barrel: re-exports all SQLite operations |
| `groups/CLAUDE.md` | Global memory/persona |

## AI Provider Architecture

Claude CLI is **not required**. Provider resolution: `group config → Settings page → env vars → Claude (if CLI available) → none`. Users can run NanoClaw first, configure AI later via Settings → AI Model. The container agent gives a clear error if no provider is set.

## Common Patterns

### Adding a Channel

1. Create `src/channels/{name}.ts` implementing `Channel` from `src/types.ts`
2. Wire into `main()` in `src/index.ts` with `onMessage`, `onChatMetadata` callbacks
3. Routing is automatic via `ownsJid()`

### Adding MCP Integration

1. Add MCP server config to container settings (`src/container-runner.ts`)
2. Document tools in `groups/CLAUDE.md`

### Changing Behavior

- Name/trigger → `src/config.ts`
- Persona → `groups/CLAUDE.md`
- Per-group → specific group's `CLAUDE.md`

### Changing Deployment

1. Create service files for target platform
2. Update paths in config

## After Changes

```bash
npm run build
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user restart nanoclaw
```
