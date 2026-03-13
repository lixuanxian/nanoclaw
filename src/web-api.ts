import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';

import { ASSISTANT_NAME, STORE_DIR } from './config.js';
import {
  countMessagesForJids,
  deleteWebSession,
  getAllMessagesForJids,
  getJidsByFolder,
  getMessagesBeforeMultiJid,
  getWebSessions,
  getAllConversationsWithUnread,
  setLastRead,
  deleteMessageById,
  updateMessageContent,
  deleteMessagesAfter,
  getMessageTimestamp,
} from './db.js';
import { getDeleteInfo, deleteConversationFull } from './web-api-cleanup.js';
import { registerGroupRoutes } from './web-api-groups.js';
import { registerLogRoutes } from './web-api-logs.js';
import { registerFileRoutes } from './web-api-files.js';
import { registerLiveLogRoutes } from './web-api-live-logs.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { WebChannel } from './channels/web.js';
import { getAuthFlow } from './whatsapp-auth-flow.js';
import {
  isChannelConfigured,
  loadAiConfig,
  loadAiConfigRedacted,
  loadDefaultProviderConfig,
  loadChannelConfigRedacted,
  saveAiConfig,
  saveChannelConfig,
  loadEnabledChannels,
  AiConfig,
} from './channel-config.js';
import { getProvider, PROVIDERS, PROVIDER_ORDER } from './providers.js';
import {
  listAllSkills,
  createCustomSkill,
  deleteCustomSkill,
  toggleSkill as toggleSkillEnabled,
  installRemoteSkill,
} from './skills.js';
import type { ChannelManager } from './web-server.js';
import type { GroupQueue } from './group-queue.js';

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB
const PAGE_SIZE = 10;

/** Strip unsafe characters from a filename to prevent path traversal. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 100);
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Register all REST API routes on the Hono app. */
export function registerApiRoutes(
  app: Hono,
  webChannel: WebChannel,
  channelManager?: ChannelManager,
  queue?: GroupQueue,
): void {
  // --- WhatsApp auth API ---
  app.post('/api/channels/whatsapp/start', async (c) => {
    const flow = getAuthFlow();
    const state = flow.getState();
    // Already in progress — return current state
    if (state.status === 'connecting' || state.status === 'qr_ready') {
      return c.json(state);
    }
    // Start in background (don't await — it resolves when auth completes or fails)
    flow
      .start()
      .catch((err) => logger.warn({ err }, 'WhatsApp auth flow error'));
    // Wait briefly for initial state update
    await new Promise((r) => setTimeout(r, 1000));
    return c.json(flow.getState());
  });

  app.get('/api/channels/whatsapp/status', (c) => {
    const flow = getAuthFlow();
    return c.json(flow.getState());
  });

  // --- Channel config API (DingTalk, Slack, etc.) ---
  app.get('/api/channels/:id/config', (c) => {
    const id = c.req.param('id');
    return c.json(loadChannelConfigRedacted(id));
  });

  app.post('/api/channels/:id/config', async (c) => {
    const id = c.req.param('id');
    const config = await c.req.json<Record<string, string>>();
    saveChannelConfig(id, config);
    logger.info({ channel: id }, 'Channel config saved');
    return c.json({ ok: true });
  });

  // --- Channel start/stop API ---
  app.post('/api/channels/:id/enable', async (c) => {
    if (!channelManager)
      return c.json({ error: 'Channel manager not available' }, 500);
    const id = c.req.param('id');
    const err = await channelManager.startChannelById(id);
    if (err) return c.json({ error: err }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/channels/:id/disable', async (c) => {
    if (!channelManager)
      return c.json({ error: 'Channel manager not available' }, 500);
    const id = c.req.param('id');
    const err = await channelManager.stopChannelById(id);
    if (err) return c.json({ error: err }, 400);
    return c.json({ ok: true });
  });

  // --- Channel status API ---
  app.get('/api/channels', (c) => {
    const activeIds = channelManager?.getActiveChannelIds() || ['web'];
    const enabledIds = loadEnabledChannels();
    return c.json({ channels: getChannelStatusList(activeIds, enabledIds) });
  });

  // --- AI config API ---
  app.get('/api/ai-config', (c) => {
    const config = loadAiConfigRedacted();
    const providers = PROVIDER_ORDER.map((id) => {
      const p = PROVIDERS[id];
      return {
        id: p.id,
        name: p.name,
        apiBase: p.apiBase,
        defaultModel: p.defaultModel,
      };
    });
    return c.json({ config, providers });
  });

  app.post('/api/ai-config', async (c) => {
    const body = await c.req.json<AiConfig>();

    // Preserve existing API keys when the incoming value is empty or redacted
    const existing = loadAiConfig();
    const mergedProviders: Record<
      string,
      { model?: string; api_base?: string; api_key?: string }
    > = {};
    for (const [id, settings] of Object.entries(body.providers || {})) {
      const incomingKey = settings.api_key || '';
      const existingKey = existing.providers[id]?.api_key || '';
      const isRedacted = incomingKey.endsWith('****');
      mergedProviders[id] = {
        ...settings,
        api_key: !incomingKey || isRedacted ? existingKey : incomingKey,
      };
    }

    saveAiConfig({
      default_provider: body.default_provider || '',
      providers: mergedProviders as AiConfig['providers'],
    });

    // Clear stale containerConfig on existing web sessions so the new
    // global config takes effect immediately (no restart needed)
    const groups = webChannel.getRegisteredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      if (jid.endsWith('@web.nanoclaw') && group.containerConfig) {
        delete group.containerConfig;
      }
    }

    logger.info({ default_provider: body.default_provider }, 'AI config saved');
    return c.json({ ok: true });
  });

  // --- Provider info for current session ---
  app.get('/api/provider/:session', (c) => {
    const sessionId = c.req.param('session');
    const jid = `${sessionId}@web.nanoclaw`;
    const groups = webChannel.getRegisteredGroups();
    const group = groups[jid];
    const defaultCfg = loadDefaultProviderConfig();
    const providerId = group?.containerConfig?.provider || defaultCfg.provider;
    const providerConfig = getProvider(providerId);
    const isSessionProvider = !!group?.containerConfig?.provider;
    return c.json({
      providerId,
      provider: providerConfig?.name || providerId,
      model:
        group?.containerConfig?.model ||
        (isSessionProvider
          ? providerConfig?.defaultModel
          : defaultCfg.model) ||
        providerConfig?.defaultModel ||
        '',
    });
  });

  // --- Web session management API ---
  app.get('/api/sessions', (c) => {
    return c.json({ sessions: getWebSessions() });
  });

  app.post('/api/sessions', async (c) => {
    const { sessionId } = await c.req.json<{ sessionId: string }>();
    if (!sessionId) return c.json({ error: 'Missing sessionId' }, 400);
    const jid = webChannel.createSession(sessionId);
    return c.json({ ok: true, jid });
  });

  app.delete('/api/sessions/:id', (c) => {
    const sessionId = c.req.param('id');
    deleteWebSession(sessionId);
    logger.info({ sessionId }, 'Web session deleted');
    return c.json({ ok: true });
  });

  // --- All-channel conversation API ---
  app.get('/api/conversations', (c) => {
    return c.json({ conversations: getAllConversationsWithUnread() });
  });

  app.post('/api/conversations/:jid/read', (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const now = new Date().toISOString();
    setLastRead(jid, now);
    return c.json({ ok: true });
  });

  app.get('/api/conversations/:jid/delete-info', (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    return c.json(getDeleteInfo(jid));
  });

  app.delete('/api/conversations/:jid', async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const body = await c.req
      .json<{ deleteFiles?: boolean }>()
      .catch(() => ({ deleteFiles: false }));
    const deleteFiles = body.deleteFiles === true;
    deleteConversationFull(jid, deleteFiles);
    webChannel.clearSessionCache(jid);
    logger.info({ jid, deleteFiles }, 'Conversation deleted');
    return c.json({ ok: true });
  });

  // --- Chat history with pagination (aggregated across all JIDs in folder) ---
  app.get('/api/history/:session', (c) => {
    const sessionId = c.req.param('session');
    const jid = c.req.query('jid') || `${sessionId}@web.nanoclaw`;
    const before = c.req.query('before');
    const around = c.req.query('around');

    // Resolve all JIDs sharing this session's folder for cross-channel aggregation
    const groups = webChannel.getRegisteredGroups();
    const group = groups[jid];
    const folder = group?.folder;
    const allJids = folder ? getJidsByFolder(folder) : [jid];

    const mapMsg = (m: {
      id: string;
      content: string;
      sender_name: string;
      timestamp: string;
      is_bot_message?: boolean;
      chat_jid: string;
    }) => ({
      id: m.id,
      content: m.content ?? '',
      sender: m.sender_name,
      timestamp: m.timestamp,
      is_bot:
        m.is_bot_message || (m.content ?? '').startsWith(`${ASSISTANT_NAME}:`),
      channel: (m.chat_jid ?? '').includes('@web.')
        ? 'web'
        : (m.chat_jid ?? '').includes('@slack.')
          ? 'slack'
          : (m.chat_jid ?? '').includes('@dingtalk.')
            ? 'dingtalk'
            : (m.chat_jid ?? '').includes('@qq.')
              ? 'qq'
              : (m.chat_jid ?? '').includes('@g.us')
                ? 'whatsapp'
                : 'unknown',
    });

    // Around: load a window of messages centered on a specific timestamp
    if (around) {
      const allMsgs = getAllMessagesForJids(allJids);
      // Find closest message to the target timestamp
      let idx = allMsgs.findIndex((m) => m.timestamp >= around);
      if (idx === -1) idx = allMsgs.length - 1;
      // Try exact match first
      const exactIdx = allMsgs.findIndex((m) => m.timestamp === around);
      if (exactIdx !== -1) idx = exactIdx;

      const half = Math.floor(PAGE_SIZE / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(allMsgs.length, start + PAGE_SIZE);
      const window = allMsgs.slice(start, end);

      return c.json({
        olderCount: start,
        messages: window.map(mapMsg),
      });
    }

    // Paginated: load PAGE_SIZE messages older than `before`
    if (before) {
      const older = getMessagesBeforeMultiJid(allJids, before, PAGE_SIZE);
      const hasMore =
        older.length === PAGE_SIZE && older[0]
          ? getMessagesBeforeMultiJid(allJids, older[0].timestamp, 1).length > 0
          : false;
      return c.json({
        olderCount: hasMore ? 1 : 0, // non-zero means "there are more"
        messages: older.map(mapMsg),
      });
    }

    // Initial load: last PAGE_SIZE messages
    const total = countMessagesForJids(allJids);
    const allMsgs = getAllMessagesForJids(allJids);
    const recent = allMsgs.slice(-PAGE_SIZE);
    const olderCount = Math.max(0, total - PAGE_SIZE);

    return c.json({
      olderCount,
      messages: recent.map(mapMsg),
    });
  });

  // --- Message actions (delete / edit) ---
  app.delete('/api/messages/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req
      .json<{ chatJid: string }>()
      .catch(() => ({ chatJid: '' }));
    if (!body.chatJid) return c.json({ error: 'Missing chatJid' }, 400);
    deleteMessageById(id, body.chatJid);
    return c.json({ ok: true });
  });

  app.put('/api/messages/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const body = await c.req
      .json<{ chatJid: string; content: string }>()
      .catch(() => ({ chatJid: '', content: '' }));
    if (!body.chatJid || !body.content)
      return c.json({ error: 'Missing chatJid or content' }, 400);

    // Get the original message timestamp so we can delete subsequent bot replies
    const ts = getMessageTimestamp(id, body.chatJid);
    if (!ts) return c.json({ error: 'Message not found' }, 404);

    // Update message content
    updateMessageContent(id, body.chatJid, body.content);

    // Delete bot messages that came after this user message (so AI re-generates)
    const groups = webChannel.getRegisteredGroups();
    const group = groups[body.chatJid];
    const folder = group?.folder;
    const allJids = folder ? getJidsByFolder(folder) : [body.chatJid];
    for (const j of allJids) {
      deleteMessagesAfter(j, ts);
    }

    return c.json({ ok: true });
  });

  // --- File upload ---
  app.post('/api/upload', async (c) => {
    const sessionId = c.req.query('session');
    if (!sessionId) return c.json({ error: 'Missing session' }, 400);

    const jid = `${sessionId}@web.nanoclaw`;
    const groups = webChannel.getRegisteredGroups();
    const group = groups[jid];
    if (!group) return c.json({ error: 'Session not registered' }, 404);

    const groupDir = resolveGroupFolderPath(group.folder);
    const uploadsDir = path.join(groupDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });

    const body = await c.req.parseBody({ all: true });
    const rawFiles = body['files'];
    const fileList = Array.isArray(rawFiles)
      ? rawFiles
      : rawFiles
        ? [rawFiles]
        : [];
    const uploaded: {
      name: string;
      storedName: string;
      size: number;
      type: string;
      url: string;
    }[] = [];

    for (const file of fileList) {
      if (!(file instanceof File)) continue;
      if (file.size > MAX_UPLOAD_SIZE) {
        return c.json(
          { error: `File too large: ${file.name} (max 10MB)` },
          413,
        );
      }
      const safeName = sanitizeFilename(file.name);
      const storedName = `${Date.now()}-${safeName}`;
      const filePath = path.join(uploadsDir, storedName);
      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      uploaded.push({
        name: file.name,
        storedName,
        size: file.size,
        type: file.type,
        url: `/api/files/${sessionId}/${storedName}`,
      });
    }

    return c.json({ files: uploaded });
  });

  // --- Skills API ---
  app.get('/api/skills', (c) => {
    return c.json({ skills: listAllSkills() });
  });

  app.post('/api/skills', async (c) => {
    const { name, description, content } = await c.req.json<{
      name: string;
      description: string;
      content: string;
    }>();
    if (!name || !content)
      return c.json({ error: 'Name and content required' }, 400);
    const skill = createCustomSkill(name, description || '', content);
    return c.json(skill);
  });

  app.delete('/api/skills/:id', (c) => {
    const id = c.req.param('id');
    if (!id.startsWith('custom-'))
      return c.json({ error: 'Cannot delete builtin skills' }, 400);
    deleteCustomSkill(id);
    return c.json({ ok: true });
  });

  app.post('/api/skills/:id/toggle', async (c) => {
    const id = c.req.param('id');
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    toggleSkillEnabled(id, enabled);
    return c.json({ ok: true });
  });

  app.post('/api/skills/install-remote', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    if (!url) return c.json({ error: 'URL required' }, 400);
    try {
      const skill = await installRemoteSkill(url);
      return c.json(skill);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  // --- Groups + Tasks routes (delegated) ---
  registerGroupRoutes(app);

  // --- Log viewing routes ---
  registerLogRoutes(app);

  // --- Live container log streaming ---
  if (queue) registerLiveLogRoutes(app, queue);

  // --- Workspace file browser routes ---
  registerFileRoutes(app);

  // --- File serving ---
  app.get('/api/files/:session/:filename', (c) => {
    const sessionId = c.req.param('session');
    const filename = c.req.param('filename');

    if (
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('..')
    ) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const jid = `${sessionId}@web.nanoclaw`;
    const groups = webChannel.getRegisteredGroups();
    const group = groups[jid];
    if (!group) return c.notFound();

    const filePath = path.join(
      resolveGroupFolderPath(group.folder),
      'uploads',
      filename,
    );
    if (!fs.existsSync(filePath)) return c.notFound();

    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isImage = contentType.startsWith('image/');

    const data = fs.readFileSync(filePath);
    return new Response(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': isImage
          ? 'inline'
          : `attachment; filename="${filename}"`,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  });
}

/** Resolve channel status: active → connected, enabled-but-inactive → error, configured → configured, else not_configured. */
function resolveChannelStatus(
  id: string,
  activeIds: string[],
  enabledIds: string[],
): string {
  if (activeIds.includes(id)) return 'connected';
  if (enabledIds.includes(id) && isChannelConfigured(id)) return 'error';
  if (isChannelConfigured(id)) return 'configured';
  return 'not_configured';
}

/** Build channel status list for the settings page. */
export function getChannelStatusList(
  activeIds: string[] = ['web'],
  enabledIds: string[] = [],
) {
  // WhatsApp has special auth flow handling
  let waStatus = resolveChannelStatus('whatsapp', activeIds, enabledIds);
  // Also check creds file for "configured" when not explicitly configured via channel-config
  if (
    waStatus === 'not_configured' &&
    fs.existsSync(`${STORE_DIR}/auth/creds.json`)
  ) {
    waStatus = 'configured';
  }
  // Override with live auth flow state if active
  const flow = getAuthFlow();
  const flowState = flow.getState();
  if (flowState.status !== 'idle') {
    waStatus = flowState.status;
  }

  return [
    {
      id: 'web',
      name: 'Web Chat',
      status: 'connected',
      enabled: true,
      configurable: false,
      guideKeys: [
        'ch.webGuide.1',
        'ch.webGuide.2',
        'ch.webGuide.3',
        'ch.webGuide.4',
      ],
    },
    {
      id: 'whatsapp',
      name: 'WhatsApp',
      status: waStatus,
      enabled: activeIds.includes('whatsapp'),
      configurable: true,
      guideKeys: [
        'ch.waGuide.1',
        'ch.waGuide.2',
        'ch.waGuide.3',
        'ch.waGuide.4',
      ],
    },
    {
      id: 'slack',
      name: 'Slack',
      status: resolveChannelStatus('slack', activeIds, enabledIds),
      enabled: activeIds.includes('slack'),
      configurable: true,
      fields: [
        {
          key: 'bot_token',
          label: 'Bot Token',
          type: 'password',
          placeholder: 'xoxb-...',
        },
        {
          key: 'app_token',
          label: 'App-Level Token',
          type: 'password',
          placeholder: 'xapp-...',
        },
      ],
      config: loadChannelConfigRedacted('slack'),
      guideKeys: [
        'ch.slackGuide.1',
        'ch.slackGuide.2',
        'ch.slackGuide.3',
        'ch.slackGuide.4',
        'ch.slackGuide.5',
        'ch.slackGuide.6',
      ],
    },
    {
      id: 'dingtalk',
      name: 'DingTalk',
      status: resolveChannelStatus('dingtalk', activeIds, enabledIds),
      enabled: activeIds.includes('dingtalk'),
      configurable: true,
      fields: [
        {
          key: 'client_id',
          label: 'Client ID (AppKey)',
          type: 'text',
          placeholder: 'dingxxxxxxxx',
        },
        {
          key: 'client_secret',
          label: 'Client Secret (AppSecret)',
          type: 'password',
          placeholder: '',
        },
        {
          key: 'webhook_url',
          label: 'Webhook URL (optional)',
          type: 'text',
          placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
        },
        {
          key: 'secret',
          label: 'Webhook Secret (optional)',
          type: 'password',
          placeholder: 'SECxxxxxxxx',
        },
      ],
      config: loadChannelConfigRedacted('dingtalk'),
      guideKeys: [
        'ch.dtGuide.1',
        'ch.dtGuide.2',
        'ch.dtGuide.3',
        'ch.dtGuide.4',
        'ch.dtGuide.5',
      ],
    },
    {
      id: 'qq',
      name: 'QQ',
      status: resolveChannelStatus('qq', activeIds, enabledIds),
      enabled: activeIds.includes('qq'),
      configurable: true,
      fields: [
        {
          key: 'app_id',
          label: 'App ID',
          type: 'text',
          placeholder: '102146862',
        },
        {
          key: 'client_secret',
          label: 'Client Secret',
          type: 'password',
          placeholder: '',
        },
      ],
      config: loadChannelConfigRedacted('qq'),
      guideKeys: [
        'ch.qqGuide.1',
        'ch.qqGuide.2',
        'ch.qqGuide.3',
        'ch.qqGuide.4',
        'ch.qqGuide.5',
      ],
    },
  ];
}
