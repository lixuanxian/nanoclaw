---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

## Architecture

```
Host                                  Container (Linux)
──────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    ├── data/env/env ──────────> /workspace/env-dir/env
    ├── groups/{folder} ───────> /workspace/group
    ├── data/ipc/{folder} ─────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/
    └── (main only) project root ──> /workspace/project
```

Container runs as user `node` (`HOME=/home/node`). Session files mount to `/home/node/.claude/`.

## Log Locations

| Log | Location |
|-----|----------|
| App logs | `logs/nanoclaw.log` |
| App errors | `logs/nanoclaw.error.log` |
| Container logs | `groups/{folder}/logs/container-*.log` |
| Claude sessions | `~/.claude/projects/` |

Debug logging: `LOG_LEVEL=debug npm run dev`

## Common Issues

### "Claude Code process exited with code 1"

Check `groups/{folder}/logs/container-*.log`.

- **Missing auth:** Add `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` to `.env`
- **Root user:** Container must run as non-root. Dockerfile should have `USER node`

### Environment Variables Not Passing

Only `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from `.env` are mounted. Verify:
```bash
echo '{}' | docker run -i -v $(pwd)/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars"'
```

### Mount Issues

Check container mounts: `docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'`

Expected: `env-dir/`, `group/`, `ipc/`, `project/` (main only), `global/` (non-main).

### Session Not Resuming

Mount path must be `/home/node/.claude/` (NOT `/root/.claude/`). Verify:
```bash
grep "/home/node/.claude" src/container-runner.ts
```

## Manual Testing

```bash
# Full agent test
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  docker run -i -v $(pwd)/data/env:/workspace/env-dir:ro \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc nanoclaw-agent:latest

# Interactive shell
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## Rebuilding

```bash
npm run build                          # Main app
./container/build.sh                   # Container
docker builder prune -af && ./container/build.sh  # Force clean rebuild
```

## IPC Debugging

Files in `/workspace/ipc/`:
- `messages/*.json` — Agent writes: outgoing messages
- `tasks/*.json` — Agent writes: task operations
- `current_tasks.json` — Host writes: task snapshot (read-only)
- `available_groups.json` — Host writes: group list for main channel (read-only)

## Quick Diagnostic

```bash
echo "=== NanoClaw Diagnostics ==="
echo "1. Auth:" && ([ -f .env ] && (grep -q "OAUTH_TOKEN\|API_KEY" .env && echo "OK" || echo "MISSING") || echo "NO .env")
echo "2. Docker:" && (docker info &>/dev/null && echo "OK" || echo "NOT RUNNING")
echo "3. Image:" && (docker images nanoclaw-agent --format "{{.Tag}}" 2>/dev/null | head -1 || echo "MISSING")
echo "4. Session mount:" && (grep -q "/home/node/.claude" src/container-runner.ts && echo "OK" || echo "WRONG")
echo "5. Recent logs:" && (ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "None")
```
