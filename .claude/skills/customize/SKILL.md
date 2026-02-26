---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

Use AskUserQuestion to understand the request, then make changes directly to the code.

## Workflow

1. **Understand** — Ask clarifying questions
2. **Plan** — Identify files to modify
3. **Implement** — Make changes
4. **Verify** — Tell user how to test

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: channel setup, subsystem wiring |
| `src/state.ts` | Runtime state, `loadState()`, `registerGroup()` |
| `src/message-loop.ts` | Message polling, `processGroupMessages()`, `runAgent()` |
| `src/providers.ts` | AI provider registry |
| `src/channel-config.ts` | Channel + AI config persistence |
| `src/web-server.ts` | Hono HTTP server, WebSocket, auth |
| `src/web-api.ts` | REST API handlers |
| `src/channels/web.ts` | Web channel (WebSocket) |
| `src/channels/slack.ts` | Slack channel (Socket Mode) |
| `src/channels/dingtalk.ts` | DingTalk channel (Stream) |
| `src/router.ts` | Message formatting, outbound routing |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/types.ts` | TypeScript interfaces (includes `Channel`) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | Barrel: re-exports all DB operations |
| `groups/CLAUDE.md` | Global memory/persona |

## AI Provider Architecture

Provider resolution: `group config → Settings page → env vars → Claude (if CLI available) → none`. Claude CLI is not required. Users can configure any provider via Settings → AI Model.

## Common Patterns

### Adding a Channel

1. Create `src/channels/{name}.ts` implementing `Channel` from `src/types.ts`
2. Wire into `main()` in `src/index.ts` with `onMessage`, `onChatMetadata` callbacks
3. Routing is automatic via `ownsJid()`

### Adding MCP Integration

1. Add MCP server config in `src/container-runner.ts`
2. Document tools in `groups/CLAUDE.md`

### Changing Behavior

- Name/trigger → `src/config.ts`
- Persona → `groups/CLAUDE.md`
- Per-group → specific group's `CLAUDE.md`

## After Changes

```bash
npm run build
```
