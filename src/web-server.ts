import crypto from 'crypto';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import {
  ADMIN_PASSWORD,
  ASSISTANT_NAME,
  setAdminPassword,
  WEB_HOST,
  WEB_PORT,
} from './config.js';
import {
  saveAdminPassword,
  clearAdminPassword,
} from './channel-config.js';
import {
  countMessagesForJids,
  getAllMessagesForJids,
  getJidsByFolder,
} from './db.js';
import { logger } from './logger.js';
import { WebChannel } from './channels/web.js';
import type { GroupQueue } from './group-queue.js';
import { registerApiRoutes } from './web-api.js';

const PAGE_SIZE = 10;

/** Stable token derived from the admin password (empty if no password set). */
function authToken(): string {
  if (!ADMIN_PASSWORD) return '';
  return crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
}

export interface ChannelManager {
  startChannelById: (id: string) => Promise<string | null>;
  stopChannelById: (id: string) => Promise<string | null>;
  getActiveChannelIds: () => string[];
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function startWebServer(
  webChannel: WebChannel,
  channelManager?: ChannelManager,
  port?: number,
  queue?: GroupQueue,
): void {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const listenPort = port ?? WEB_PORT;
  const webDistDir = join(process.cwd(), 'web', 'dist');
  const getIndexHtml = (): string => {
    const indexHtmlPath = join(webDistDir, 'index.html');
    const mainBundlePath = join(webDistDir, 'assets', 'main.js');
    if (!existsSync(indexHtmlPath)) {
      return '<html><body>Web UI not built. Run <code>npm run build:web</code></body></html>';
    }
    const mainBundleVersion = existsSync(mainBundlePath)
      ? String(Math.floor(statSync(mainBundlePath).mtimeMs))
      : '';
    const mainCssPath = join(webDistDir, 'assets', 'main.css');
    const mainCssVersion = existsSync(mainCssPath)
      ? String(Math.floor(statSync(mainCssPath).mtimeMs))
      : '';
    let html = readFileSync(indexHtmlPath, 'utf-8');
    if (mainBundleVersion) {
      html = html.replace(
        '/assets/main.js',
        `/assets/main.js?v=${mainBundleVersion}`,
      );
    }
    if (mainCssVersion) {
      html = html.replace(
        '/assets/main.css',
        `/assets/main.css?v=${mainCssVersion}`,
      );
    }
    return html;
  };

  app.get('/favicon.ico', (c) => {
    const filePath = join(webDistDir, 'favicon.ico');
    if (!existsSync(filePath)) return c.notFound();
    const buf = readFileSync(filePath);
    return c.body(buf, 200, {
      'Content-Type': 'image/x-icon',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    });
  });

  // --- Auth middleware (always registered, dynamically checks ADMIN_PASSWORD) ---
  const publicPaths = new Set([
    '/login',
    '/api/login',
    '/api/admin-password/status',
    '/.well-known/agent-card.json',
    '/favicon.ico',
  ]);

  app.use('*', async (c, next) => {
    if (!ADMIN_PASSWORD) return next();
    const path = c.req.path;
    if (publicPaths.has(path)) return next();
    if (path.startsWith('/assets/')) return next();
    const cookie = getCookie(c, 'nanoclaw_auth');
    if (cookie === authToken()) return next();
    if (path.startsWith('/api/') || path === '/ws') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.redirect('/login');
  });

  // --- Login API ---
  app.post('/api/login', async (c) => {
    if (!ADMIN_PASSWORD) return c.redirect('/');
    const body = await c.req.parseBody();
    const password = typeof body.password === 'string' ? body.password : '';

    if (password !== ADMIN_PASSWORD) {
      return c.json({ error: 'Incorrect password' }, 401);
    }

    setCookie(c, 'nanoclaw_auth', authToken(), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });
    return c.redirect('/');
  });

  app.get('/api/logout', (c) => {
    deleteCookie(c, 'nanoclaw_auth', { path: '/' });
    return c.redirect('/login');
  });

  // --- Admin password management ---
  app.get('/api/admin-password/status', (c) => {
    return c.json({ hasPassword: !!ADMIN_PASSWORD });
  });

  app.post('/api/admin-password', async (c) => {
    const body = await c.req.json<{
      currentPassword?: string;
      newPassword: string;
    }>();
    const newPw = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!newPw) {
      return c.json({ error: 'New password is required' }, 400);
    }

    // If password already set, verify current password
    if (ADMIN_PASSWORD) {
      const cur =
        typeof body.currentPassword === 'string' ? body.currentPassword : '';
      if (cur !== ADMIN_PASSWORD) {
        return c.json({ error: 'Incorrect current password' }, 401);
      }
    }

    // Save and apply
    saveAdminPassword(newPw);
    setAdminPassword(newPw);

    // Set auth cookie so the current session stays authenticated
    setCookie(c, 'nanoclaw_auth', authToken(), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });

    return c.json({ ok: true });
  });

  app.delete('/api/admin-password', async (c) => {
    const body = await c.req.json<{ currentPassword: string }>();
    const cur =
      typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!ADMIN_PASSWORD || cur !== ADMIN_PASSWORD) {
      return c.json({ error: 'Incorrect current password' }, 401);
    }

    clearAdminPassword();
    setAdminPassword('');
    deleteCookie(c, 'nanoclaw_auth', { path: '/' });
    return c.json({ ok: true });
  });

  // --- Agent Card discovery (A2A protocol) ---
  app.get('/.well-known/agent-card.json', (c) => {
    return c.json({
      name: ASSISTANT_NAME,
      description: `Personal AI assistant powered by NanoClaw`,
      url: `http://${WEB_HOST === '0.0.0.0' ? 'localhost' : WEB_HOST}:${listenPort}`,
      version: '1.0.0',
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [
        {
          id: 'chat',
          name: 'General Assistant',
          description: 'Chat, task execution, code, web search, and more',
        },
      ],
    });
  });

  // --- REST API routes (channels, AI config, sessions, history, files) ---
  registerApiRoutes(app, webChannel, channelManager, queue);

  // --- WebSocket ---
  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const sessionId =
        c.req.query('session') || WebChannel.generateSessionId();
      const requestedJid = c.req.query('jid') || null;

      // Viewing a non-web channel's history (read-only until user sends a message)
      let isHistoryView =
        requestedJid != null && !requestedJid.endsWith('@web.nanoclaw');
      let connectionRegistered = false;

      return {
        onOpen(_evt, ws) {
          if (!isHistoryView) {
            webChannel.handleConnection(
              sessionId,
              ws as unknown as {
                send(data: string): void;
                close(): void;
                readyState: number;
              },
            );
            connectionRegistered = true;
          }

          // Use requested JID for history lookup (non-web channels), fall back to web JID
          const jid = requestedJid || `${sessionId}@web.nanoclaw`;
          try {
            const groups = webChannel.getRegisteredGroups();
            const group = groups[jid];
            const folder = group?.folder;
            const allJids = folder ? getJidsByFolder(folder) : [jid];
            const total = countMessagesForJids(allJids);
            const allMsgs = getAllMessagesForJids(allJids);
            const recent = allMsgs.slice(-PAGE_SIZE);
            const olderCount = Math.max(0, total - PAGE_SIZE);
            ws.send(
              JSON.stringify({
                type: 'history',
                olderCount,
                messages: recent.map((m) => ({
                  id: m.id,
                  content: m.content ?? '',
                  sender: m.sender_name,
                  timestamp: m.timestamp,
                  is_bot:
                    m.is_bot_message ||
                    (m.content ?? '').startsWith(`${ASSISTANT_NAME}:`),
                  channel: (m.chat_jid ?? '').includes('@web.')
                    ? 'web'
                    : (m.chat_jid ?? '').includes('@slack.')
                      ? 'slack'
                      : (m.chat_jid ?? '').includes('@dingtalk.')
                        ? 'dingtalk'
                        : (m.chat_jid ?? '').includes('@g.us')
                          ? 'whatsapp'
                          : 'unknown',
                })),
              }),
            );
          } catch (err) {
            logger.warn({ err, jid }, 'Failed to send chat history on WebSocket open');
          }
        },

        onMessage(evt, ws) {
          try {
            const data = JSON.parse(String(evt.data));
            if (data.type === 'message' && (data.text || data.files)) {
              // Transition from history view to active session: register WS
              // and join the viewed channel's folder so the message lands in
              // the same conversation instead of creating a new web chat.
              if (isHistoryView && requestedJid) {
                isHistoryView = false;
                webChannel.handleConnection(
                  sessionId,
                  ws as unknown as {
                    send(data: string): void;
                    close(): void;
                    readyState: number;
                  },
                );
                connectionRegistered = true;

                const groups = webChannel.getRegisteredGroups();
                const viewedGroup = groups[requestedJid];
                const targetFolder = viewedGroup?.folder;
                webChannel.handleMessage(
                  sessionId,
                  data.text || '',
                  data.files,
                  data.mode,
                  data.skills,
                  targetFolder,
                );
              } else {
                webChannel.handleMessage(
                  sessionId,
                  data.text || '',
                  data.files,
                  data.mode,
                  data.skills,
                );
              }
            }
          } catch (err) {
            logger.warn({ err }, 'Invalid WebSocket message');
          }
        },

        onClose() {
          if (connectionRegistered) {
            webChannel.handleDisconnect(sessionId);
          }
        },
      };
    }),
  );

  // --- Static files from web/dist/assets/ ---
  app.get('/assets/*', (c) => {
    const filePath = join(webDistDir, c.req.path);
    if (!existsSync(filePath)) return c.notFound();
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const buf = readFileSync(filePath);
    return c.body(buf, 200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=0, must-revalidate',
    });
  });

  // --- SPA fallback: serve index.html for all non-API routes ---
  const isDev = process.env.NODE_ENV === 'development';
  app.get('*', (c) => {
    if (isDev) c.header('Cache-Control', 'no-cache');
    return c.html(getIndexHtml());
  });

  // --- Start server ---
  const server = serve({
    fetch: app.fetch,
    hostname: WEB_HOST,
    port: listenPort,
  });

  injectWebSocket(server);

  // Always log the server URL on startup, even if the user has disabled other logging
  console.log(`Web server started at http://${WEB_HOST}:${listenPort}`);
}
