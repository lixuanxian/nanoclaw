/**
 * Log viewing API routes.
 * Allows the web UI to list, read, and delete container execution logs.
 */
import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';

import { resolveGroupFolderPath } from './group-folder.js';

const MAX_LOG_SIZE = 512 * 1024; // 512 KB — truncate larger files

export interface LogFileInfo {
  name: string;
  timestamp: string;
  size: number;
  modifiedAt: string;
}

function listLogFiles(logsDir: string): LogFileInfo[] {
  if (!fs.existsSync(logsDir)) return [];

  const entries = fs
    .readdirSync(logsDir)
    .filter((f) => f.startsWith('container-') && f.endsWith('.log'));

  const logs: LogFileInfo[] = entries.map((name) => {
    const filePath = path.join(logsDir, name);
    const stat = fs.statSync(filePath);
    const tsMatch = name.match(/^container-(.+)\.log$/);
    const timestamp = tsMatch
      ? tsMatch[1]
          .replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3')
          .replace(/:(\d{2})-(\d{3})/, ':$1.$2')
      : stat.mtime.toISOString();
    return {
      name,
      timestamp,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  });

  // Sort by timestamp descending (newest first)
  logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return logs;
}

/** Register log-viewing API routes on the Hono app. */
export function registerLogRoutes(app: Hono): void {
  // List log files for a group folder
  app.get('/api/logs/:folder', (c) => {
    const folder = c.req.param('folder');
    let groupPath: string;
    try {
      groupPath = resolveGroupFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const logsDir = path.join(groupPath, 'logs');
    return c.json({ logs: listLogFiles(logsDir) });
  });

  // Read a specific log file
  app.get('/api/logs/:folder/:filename', (c) => {
    const folder = c.req.param('folder');
    const filename = c.req.param('filename');

    // Security: validate filename format
    if (
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('..') ||
      !filename.startsWith('container-') ||
      !filename.endsWith('.log')
    ) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    let groupPath: string;
    try {
      groupPath = resolveGroupFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const filePath = path.join(groupPath, 'logs', filename);
    if (!fs.existsSync(filePath)) {
      return c.json({ error: 'Log not found' }, 404);
    }

    const stat = fs.statSync(filePath);
    let content: string;

    if (stat.size > MAX_LOG_SIZE) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(MAX_LOG_SIZE);
      fs.readSync(fd, buf, 0, MAX_LOG_SIZE, stat.size - MAX_LOG_SIZE);
      fs.closeSync(fd);
      content = '[... truncated ...]\n' + buf.toString('utf-8');
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }

    return c.json({ content, size: stat.size });
  });

  // Delete a specific log file
  app.delete('/api/logs/:folder/:filename', (c) => {
    const folder = c.req.param('folder');
    const filename = c.req.param('filename');

    if (
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('..') ||
      !filename.startsWith('container-') ||
      !filename.endsWith('.log')
    ) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    let groupPath: string;
    try {
      groupPath = resolveGroupFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const filePath = path.join(groupPath, 'logs', filename);
    if (!fs.existsSync(filePath)) {
      return c.json({ error: 'Log not found' }, 404);
    }

    fs.unlinkSync(filePath);
    return c.json({ ok: true });
  });

  // Delete old logs, keeping only the last N (default 3)
  app.post('/api/logs/:folder/cleanup', async (c) => {
    const folder = c.req.param('folder');
    const body = (await c.req.json().catch(() => ({}))) as { keep?: number };
    const keep = Math.max(1, body.keep ?? 3);

    let groupPath: string;
    try {
      groupPath = resolveGroupFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const logsDir = path.join(groupPath, 'logs');
    const logs = listLogFiles(logsDir); // already sorted newest-first

    const toDelete = logs.slice(keep);
    for (const log of toDelete) {
      const filePath = path.join(logsDir, log.name);
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }

    return c.json({
      deleted: toDelete.map((l) => l.name),
      remaining: logs.length - toDelete.length,
    });
  });
}
