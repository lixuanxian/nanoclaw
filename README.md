<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

Using Claude Code, NanoClaw can dynamically rewrite its code to customize its feature set for your needs.

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is application-level (allowlists, pairing codes), not OS-level isolation.

NanoClaw provides the same core functionality in a codebase small enough to understand: one process, a handful of files. Agents run in real Linux containers with filesystem isolation.

## Quick Start

```bash
git clone https://github.com/lixuanxian/NanoClaw.git
cd NanoClaw
npm install
cd web && npm install && cd ..
npm run build:web
npm run dev
```

Open `http://localhost:3030` to chat. Configure your AI provider in Settings → AI Model.

**With Claude Code (optional):** Run `claude` then `/setup` for guided setup including WhatsApp, scheduled tasks, and background services.

## Philosophy

- **Small enough to understand.** One process, a few source files, no microservices.
- **Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker). Only mounted directories are accessible.
- **Built for the individual.** Fork it, have Claude Code modify it to match your needs. Not a monolithic framework.
- **Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code.
- **AI-native.** Claude Code guides setup, debugging, and customization. Without it, configure any AI provider in Settings.
- **Skills over features.** Contributors submit [Claude Code skills](https://code.claude.com/docs/en/skills) that transform your fork, keeping code clean.
- **Best harness, best model.** Claude runs on the Claude Agent SDK. Other providers use their native APIs.

## Features

- **Multi-AI provider** — Claude, DeepSeek, MiniMax, QWEN, DOUBAO, OpenAI-compatible, Claude-compatible. Configure from Settings or env vars
- **Web chat UI** — React + Ant Design SPA with dark/light theme, WebSocket messaging, session persistence
- **Multi-channel sync** — Web (default), WhatsApp, Telegram, Discord, Slack, Signal, DingTalk. All channels sharing a folder sync to one conversation
- **Container isolation** — Agents sandboxed in Apple Container (macOS) or Docker (macOS/Linux/Windows)
- **Isolated group context** — Each group has its own `CLAUDE.md` memory, filesystem, and container sandbox
- **Scheduled tasks** — Recurring jobs that run agents and message you back
- **Web access** — Search and fetch content from the web
- **Agent Swarms** — Teams of specialized agents collaborating on complex tasks
- **A2A protocol** — Agent Card discovery at `/.well-known/agent-card.json`
- **Settings page** — Configure AI providers, channels, and integrations from the browser
- **Password protection** — Optional `ADMIN_PASSWORD` for securing the web UI

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am
@Andy review the git history weekly and update the README if there's drift
@Andy every Monday at 8am, compile AI news from Hacker News and TechCrunch
```

From the main channel, manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

Tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Make responses shorter and more direct"
- "Add a custom greeting when I say good morning"

Or run `/customize` for guided changes.

## Contributing

**Don't add features. Add skills.**

Contribute a skill file (`.claude/skills/<name>/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation. Users run the skill on their fork and get clean code.

### RFS (Request for Skills)

- `/clear` — Compact conversation (summarize context while preserving critical information). Requires programmatic compaction via Claude Agent SDK.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux/Windows)
- An AI provider API key (configure in Settings), or [Claude Code](https://claude.ai/download) (auto-detected as default)

## Architecture

```
                    ┌─── Web Chat
                    │
AI Agent ◄──► NanoClaw ──┼─── Slack
                    │
                    ├─── WhatsApp
                    │
                    └─── DingTalk / ...
```

Single Node.js process. Channels are config-driven. All channels sharing the default folder sync to one conversation. Agents execute in isolated Linux containers. Per-folder message queue with concurrency control. IPC via filesystem.

Key files: `src/index.ts` (orchestrator), `src/web-server.ts` (HTTP/WS), `src/message-loop.ts` (polling), `src/container-runner.ts` (agent containers), `src/router.ts` (routing), `src/db.ts` (SQLite), `web/` (React SPA).

## FAQ

**Why Docker?** Cross-platform support and mature ecosystem. On macOS, optionally switch to Apple Container via `/convert-to-apple-container`.

**Can I run this on Windows/Linux?** Yes. Docker Desktop (Windows with WSL2) or Docker (Linux). Run `/setup`.

**Is this secure?** Agents run in containers with filesystem isolation. Only explicitly mounted directories are accessible. See [docs/SECURITY.md](docs/SECURITY.md).

**Why no configuration files?** Customize the code directly instead of configuring a generic system. The codebase is small enough to safely modify.

**How do I debug?** Ask Claude Code, or run `/debug`.

**What PRs are accepted?** Security fixes, bug fixes, and clear improvements only. Everything else should be contributed as skills.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## License

MIT
