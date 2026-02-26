/**
 * Workspace file browser API routes.
 * Browse, read, edit, rename, and delete files within group working directories.
 */
import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';

import { GROUPS_DIR } from './config.js';
import { getJidsByFolder } from './db.js';
import { getDb } from './db-init.js';
import { logger } from './logger.js';

const MAX_READ_SIZE = 2 * 1024 * 1024; // 2 MB
const EDITABLE_EXTS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.log',
  '.sh', '.py', '.js', '.ts', '.html', '.css', '.env', '.conf',
]);
const PROTECTED_FOLDERS = new Set(['global', 'main']);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface FolderConversation {
  jid: string;
  name: string;
  channel: string;
}

export interface FolderInfo {
  folder: string;
  hasConversation: boolean;
  conversationCount: number;
  protected: boolean;
  conversations: FolderConversation[];
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  editable: boolean;
}

/** Sanitise a subpath to prevent traversal attacks. */
function sanitizePath(subpath: string): string {
  return subpath
    .split(/[/\\]+/)
    .filter((s) => s && s !== '..' && s !== '.')
    .join('/');
}

const FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Resolve a group folder path for workspace browsing. Allows protected folders (global, main). */
function resolveWorkspaceFolderPath(folder: string): string {
  if (!folder || !FOLDER_PATTERN.test(folder)) throw new Error('Invalid folder name');
  const resolved = path.resolve(GROUPS_DIR, folder);
  const rel = path.relative(GROUPS_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes base');
  return resolved;
}

/** Register workspace file-browser API routes on the Hono app. */
export function registerFileRoutes(app: Hono): void {
  // List all group folders with conversation counts
  app.get('/api/workspace/folders', (c) => {
    if (!fs.existsSync(GROUPS_DIR)) return c.json({ folders: [] });

    const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));

    const folders: FolderInfo[] = entries.map((e) => {
      const jids = getJidsByFolder(e.name);
      let conversations: FolderConversation[] = [];
      if (jids.length > 0) {
        const rows = getDb().prepare(
          `SELECT rg.jid, rg.name FROM registered_groups rg WHERE rg.folder = ?`,
        ).all(e.name) as Array<{ jid: string; name: string }>;
        conversations = rows.map((r) => ({
          jid: r.jid,
          name: r.name,
          channel: channelFromJid(r.jid),
        }));
      }
      return {
        folder: e.name,
        hasConversation: jids.length > 0,
        conversationCount: jids.length,
        protected: PROTECTED_FOLDERS.has(e.name.toLowerCase()),
        conversations,
      };
    });

    folders.sort((a, b) => a.folder.localeCompare(b.folder));
    return c.json({ folders });
  });

  // Browse a directory
  app.get('/api/workspace/browse/:folder{.+}', (c) => {
    const raw = c.req.param('folder');
    const parts = raw.split('/');
    const folder = parts[0];
    const subpath = sanitizePath(parts.slice(1).join('/'));

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const targetDir = subpath ? path.join(groupPath, subpath) : groupPath;
    const resolved = path.resolve(targetDir);
    if (!resolved.startsWith(groupPath)) return c.json({ error: 'Path outside workspace' }, 400);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return c.json({ error: 'Directory not found' }, 404);
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });

    const files: FileEntry[] = entries.map((e) => {
      const filePath = path.join(resolved, e.name);
      const stat = fs.statSync(filePath);
      const ext = path.extname(e.name).toLowerCase();
      return {
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        editable: !e.isDirectory() && EDITABLE_EXTS.has(ext),
      };
    });

    // Directories first, then alphabetical
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({ path: subpath || '', files });
  });

  // Read file content
  app.get('/api/workspace/read/:folder{.+}', (c) => {
    const raw = c.req.param('folder');
    const parts = raw.split('/');
    const folder = parts[0];
    const subpath = sanitizePath(parts.slice(1).join('/'));
    if (!subpath) return c.json({ error: 'File path required' }, 400);

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const filePath = path.resolve(groupPath, subpath);
    if (!filePath.startsWith(groupPath)) return c.json({ error: 'Path outside workspace' }, 400);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return c.json({ error: 'File not found' }, 404);
    }

    const stat = fs.statSync(filePath);
    if (stat.size > MAX_READ_SIZE) {
      return c.json({ error: 'File too large (max 2MB)' }, 413);
    }

    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf-8');
    return c.json({ content, editable: EDITABLE_EXTS.has(ext), size: stat.size });
  });

  // Write/edit file content
  app.put('/api/workspace/write/:folder{.+}', async (c) => {
    const raw = c.req.param('folder');
    const parts = raw.split('/');
    const folder = parts[0];
    const subpath = sanitizePath(parts.slice(1).join('/'));
    if (!subpath) return c.json({ error: 'File path required' }, 400);

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const filePath = path.resolve(groupPath, subpath);
    if (!filePath.startsWith(groupPath)) return c.json({ error: 'Path outside workspace' }, 400);

    const ext = path.extname(filePath).toLowerCase();
    if (!EDITABLE_EXTS.has(ext)) return c.json({ error: 'File type not editable' }, 400);

    const body = await c.req.json<{ content: string }>();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body.content, 'utf-8');
    logger.info({ folder, subpath }, 'Workspace file written');
    return c.json({ ok: true });
  });

  // Delete file or directory
  app.delete('/api/workspace/delete/:folder{.+}', (c) => {
    const raw = c.req.param('folder');
    const parts = raw.split('/');
    const folder = parts[0];
    const subpath = sanitizePath(parts.slice(1).join('/'));

    // Protect the folder root itself for global/main
    if (!subpath && PROTECTED_FOLDERS.has(folder.toLowerCase())) {
      return c.json({ error: 'Cannot delete protected folder' }, 403);
    }

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const targetPath = subpath ? path.resolve(groupPath, subpath) : groupPath;
    if (!targetPath.startsWith(path.resolve(GROUPS_DIR))) {
      return c.json({ error: 'Path outside workspace' }, 400);
    }
    if (!fs.existsSync(targetPath)) return c.json({ error: 'Not found' }, 404);

    fs.rmSync(targetPath, { recursive: true, force: true });
    logger.info({ folder, subpath: subpath || '(root)' }, 'Workspace item deleted');
    return c.json({ ok: true });
  });

  // Rename file or directory
  app.post('/api/workspace/rename/:folder', async (c) => {
    const folder = c.req.param('folder');
    const body = await c.req.json<{ from: string; to: string }>();
    const fromSub = sanitizePath(body.from);
    const toSub = sanitizePath(body.to);
    if (!fromSub || !toSub) return c.json({ error: 'Invalid path' }, 400);

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const fromPath = path.resolve(groupPath, fromSub);
    const toPath = path.resolve(groupPath, toSub);
    if (!fromPath.startsWith(groupPath) || !toPath.startsWith(groupPath)) {
      return c.json({ error: 'Path outside workspace' }, 400);
    }
    if (!fs.existsSync(fromPath)) return c.json({ error: 'Source not found' }, 404);
    if (fs.existsSync(toPath)) return c.json({ error: 'Destination already exists' }, 409);

    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.renameSync(fromPath, toPath);
    logger.info({ folder, from: fromSub, to: toSub }, 'Workspace item renamed');
    return c.json({ ok: true });
  });

  // Serve raw file (binary-safe, for download / PDF / audio / video preview)
  app.get('/api/workspace/raw/:folder{.+}', (c) => {
    const raw = c.req.param('folder');
    const parts = raw.split('/');
    const folder = parts[0];
    const subpath = sanitizePath(parts.slice(1).join('/'));
    if (!subpath) return c.json({ error: 'File path required' }, 400);

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const filePath = path.resolve(groupPath, subpath);
    if (!filePath.startsWith(groupPath)) return c.json({ error: 'Path outside workspace' }, 400);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return c.json({ error: 'File not found' }, 404);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileName = path.basename(filePath);
    const download = c.req.query('download') === '1';

    const data = fs.readFileSync(filePath);
    return new Response(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': download
          ? `attachment; filename="${encodeURIComponent(fileName)}"`
          : 'inline',
        'Cache-Control': 'private, max-age=300',
      },
    });
  });

  // Create a new directory
  app.post('/api/workspace/mkdir/:folder{.+}', (c) => {
    const raw = c.req.param('folder');
    const parts = raw.split('/');
    const folder = parts[0];
    const subpath = sanitizePath(parts.slice(1).join('/'));
    if (!subpath) return c.json({ error: 'Directory path required' }, 400);

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const dirPath = path.resolve(groupPath, subpath);
    if (!dirPath.startsWith(groupPath)) return c.json({ error: 'Path outside workspace' }, 400);
    if (fs.existsSync(dirPath)) return c.json({ error: 'Already exists' }, 409);

    fs.mkdirSync(dirPath, { recursive: true });
    logger.info({ folder, subpath }, 'Workspace directory created');
    return c.json({ ok: true });
  });

  // Create a new empty file
  app.post('/api/workspace/touch/:folder{.+}', (c) => {
    const raw = c.req.param('folder');
    const parts = raw.split('/');
    const folder = parts[0];
    const subpath = sanitizePath(parts.slice(1).join('/'));
    if (!subpath) return c.json({ error: 'File path required' }, 400);

    let groupPath: string;
    try {
      groupPath = resolveWorkspaceFolderPath(folder);
    } catch {
      return c.json({ error: 'Invalid folder' }, 400);
    }

    const filePath = path.resolve(groupPath, subpath);
    if (!filePath.startsWith(groupPath)) return c.json({ error: 'Path outside workspace' }, 400);
    if (fs.existsSync(filePath)) return c.json({ error: 'Already exists' }, 409);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf-8');
    logger.info({ folder, subpath }, 'Workspace file created');
    return c.json({ ok: true });
  });

  // Cleanup orphan folders (no conversations)
  app.post('/api/workspace/cleanup-orphans', (c) => {
    if (!fs.existsSync(GROUPS_DIR)) return c.json({ deleted: [] });

    const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));

    const deleted: string[] = [];
    for (const e of entries) {
      if (PROTECTED_FOLDERS.has(e.name.toLowerCase())) continue;
      const jids = getJidsByFolder(e.name);
      if (jids.length > 0) continue;

      const dirPath = path.join(GROUPS_DIR, e.name);
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        deleted.push(e.name);
        logger.info({ folder: e.name }, 'Orphan folder cleaned up');
      } catch (err) {
        logger.warn({ folder: e.name, err }, 'Failed to clean orphan folder');
      }
    }

    return c.json({ deleted });
  });
}

function channelFromJid(jid: string): string {
  if (jid.includes('@web.')) return 'web';
  if (jid.includes('@slack.')) return 'slack';
  if (jid.includes('@dingtalk.')) return 'dingtalk';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  if (jid.includes('tg:')) return 'telegram';
  return 'unknown';
}
