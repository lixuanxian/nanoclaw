---
name: update
description: Update NanoClaw from upstream. Fetches latest changes, merges with customizations and skills, runs migrations.
---

# Update NanoClaw

Pull upstream changes and merge with user's installation, preserving skills and customizations. Scripts in `.claude/skills/update/scripts/`.

**Principle:** Handle everything automatically. Only pause for user confirmation before applying, or when merge conflicts need human judgment.

## 1. Pre-flight

Check skills system initialized:
```bash
test -d .nanoclaw && echo "INITIALIZED" || echo "NOT_INITIALIZED"
```

If NOT_INITIALIZED: `npx tsx -e "import { initNanoclawDir } from './skills-engine/init.js'; initNanoclawDir();"`

Check for uncommitted changes (`git status --porcelain`). If dirty, warn user via `AskUserQuestion` with options: "Continue anyway" / "Abort (I'll commit first)".

## 2. Fetch upstream

```bash
./.claude/skills/update/scripts/fetch-upstream.sh
```

Parse structured status block (`<<< STATUS` / `STATUS >>>`). Extract: `TEMP_DIR`, `REMOTE`, `CURRENT_VERSION`, `NEW_VERSION`, `STATUS`.

If error: show output, stop. If versions match: ask user if they want to force update anyway.

## 3. Preview

```bash
npx tsx scripts/update-core.ts --json --preview-only <TEMP_DIR>
```

Present to user: version change, files changed/deleted, conflict risks, custom patches at risk.

## 4. Confirm

`AskUserQuestion`: "Apply this update?" → "Yes, apply" / "No, cancel". If cancelled, clean temp dir, stop.

## 5. Apply

```bash
npx tsx scripts/update-core.ts --json <TEMP_DIR>
```

Parse JSON result: `success`, `mergeConflicts`, `backupPending`, `customPatchFailures`, `skillReapplyResults`.

## 6. Handle conflicts

If `backupPending=true`: read each conflicted file, check intent files in `.claude/skills/<skill>/modify/<path>.intent.md`, resolve conflicts. After resolving: `npx tsx scripts/post-update.ts`. If unsure, show user the conflicts.

## 7. Run migrations

```bash
npx tsx scripts/run-migrations.ts <CURRENT_VERSION> <NEW_VERSION> <TEMP_DIR>
```

Show errors if any migration fails.

## 8. Verify

```bash
npm run build && npm test
```

Fix build errors (type errors, missing deps with `npm install`). Report test failures.

## 9. Cleanup

`rm -rf <TEMP_DIR>`. Report: version change, files changed, warnings, build/test status.

## Troubleshooting

- **No upstream remote:** Fetch script auto-adds `upstream` → `https://github.com/lixuanxian/nanoclaw.git`
- **Many merge conflicts:** Suggest using skills system instead of direct core edits
- **Build fails:** Run `npm install` for new dependencies
- **Rollback:** `npx tsx -e "import { restoreBackup, clearBackup } from './skills-engine/backup.js'; restoreBackup(); clearBackup();"`
