import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';

import { ASSISTANT_NAME, STORE_DIR } from './config.js';
import { countMessagesForJids, deleteWebSession, getAllMessagesForJids, getJidsByFolder, getMessagesBeforeMultiJid, getWebSessions, getAllConversations, deleteConversation } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { WebChannel } from './channels/web.js';
import { getAuthFlow } from './whatsapp-auth-flow.js';
import { isChannelConfigured, loadAiConfigRedacted, loadDefaultProviderConfig, loadChannelConfigRedacted, saveAiConfig, saveChannelConfig, AiConfig } from './channel-config.js';
import { getProvider, PROVIDERS, PROVIDER_ORDER } from './providers.js';
import { listAllSkills, createCustomSkill, deleteCustomSkill, toggleSkill as toggleSkillEnabled, installRemoteSkill } from './skills.js';
import type { ChannelManager } from './web-server.js';

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
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.json': 'application/json', '.csv': 'text/csv',
  '.zip': 'application/zip', '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Register all REST API routes on the Hono app. */
export function registerApiRoutes(app: Hono, webChannel: WebChannel, channelManager?: ChannelManager): void {
  // --- WhatsApp auth API ---
  app.post('/api/channels/whatsapp/start', async (c) => {
    const flow = getAuthFlow();
    const state = flow.getState();
    // Already in progress — return current state
    if (state.status === 'connecting' || state.status === 'qr_ready') {
      return c.json(state);
    }
    // Start in background (don't await — it resolves when auth completes or fails)
    flow.start().catch((err) =>
      logger.warn({ err }, 'WhatsApp auth flow error'),
    );
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
    if (!channelManager) return c.json({ error: 'Channel manager not available' }, 500);
    const id = c.req.param('id');
    const err = await channelManager.startChannelById(id);
    if (err) return c.json({ error: err }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/channels/:id/disable', async (c) => {
    if (!channelManager) return c.json({ error: 'Channel manager not available' }, 500);
    const id = c.req.param('id');
    const err = await channelManager.stopChannelById(id);
    if (err) return c.json({ error: err }, 400);
    return c.json({ ok: true });
  });

  // --- Channel status API ---
  app.get('/api/channels', (c) => {
    const activeIds = channelManager?.getActiveChannelIds() || ['web'];
    return c.json({ channels: getChannelStatusList(activeIds) });
  });

  // --- AI config API ---
  app.get('/api/ai-config', (c) => {
    const config = loadAiConfigRedacted();
    const providers = PROVIDER_ORDER.map((id) => {
      const p = PROVIDERS[id];
      return { id: p.id, name: p.name, apiBase: p.apiBase, defaultModel: p.defaultModel };
    });
    return c.json({ config, providers });
  });

  app.post('/api/ai-config', async (c) => {
    const body = await c.req.json<AiConfig>();
    saveAiConfig({
      default_provider: body.default_provider || '',
      providers: body.providers || {},
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
    return c.json({
      provider: providerConfig?.name || providerId,
      model: group?.containerConfig?.model || defaultCfg.model || providerConfig?.defaultModel || '',
    });
  });

  // --- Web session management API ---
  app.get('/api/sessions', (c) => {
    return c.json({ sessions: getWebSessions() });
  });

  app.delete('/api/sessions/:id', (c) => {
    const sessionId = c.req.param('id');
    deleteWebSession(sessionId);
    logger.info({ sessionId }, 'Web session deleted');
    return c.json({ ok: true });
  });

  // --- All-channel conversation API ---
  app.get('/api/conversations', (c) => {
    return c.json({ conversations: getAllConversations() });
  });

  app.delete('/api/conversations/:jid', (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    deleteConversation(jid);
    logger.info({ jid }, 'Conversation deleted');
    return c.json({ ok: true });
  });

  // --- Chat history with pagination (aggregated across all JIDs in folder) ---
  app.get('/api/history/:session', (c) => {
    const sessionId = c.req.param('session');
    const jid = c.req.query('jid') || `${sessionId}@web.nanoclaw`;
    const before = c.req.query('before');

    // Resolve all JIDs sharing this session's folder for cross-channel aggregation
    const groups = webChannel.getRegisteredGroups();
    const group = groups[jid];
    const folder = group?.folder;
    const allJids = folder ? getJidsByFolder(folder) : [jid];

    const mapMsg = (m: { content: string; sender_name: string; timestamp: string; is_bot_message?: boolean; chat_jid: string }) => ({
      content: m.content,
      sender: m.sender_name,
      timestamp: m.timestamp,
      is_bot: m.is_bot_message || m.content.startsWith(`${ASSISTANT_NAME}:`),
      channel: m.chat_jid.includes('@web.') ? 'web'
        : m.chat_jid.includes('@slack.') ? 'slack'
        : m.chat_jid.includes('@dingtalk.') ? 'dingtalk'
        : m.chat_jid.includes('@g.us') ? 'whatsapp' : 'unknown',
    });

    // Paginated: load PAGE_SIZE messages older than `before`
    if (before) {
      const older = getMessagesBeforeMultiJid(allJids, before, PAGE_SIZE);
      const hasMore = older.length === PAGE_SIZE && older[0]
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
    const fileList = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];
    const uploaded: { name: string; storedName: string; size: number; type: string; url: string }[] = [];

    for (const file of fileList) {
      if (!(file instanceof File)) continue;
      if (file.size > MAX_UPLOAD_SIZE) {
        return c.json({ error: `File too large: ${file.name} (max 10MB)` }, 413);
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
      name: string; description: string; content: string;
    }>();
    if (!name || !content) return c.json({ error: 'Name and content required' }, 400);
    const skill = createCustomSkill(name, description || '', content);
    return c.json(skill);
  });

  app.delete('/api/skills/:id', (c) => {
    const id = c.req.param('id');
    if (!id.startsWith('custom-')) return c.json({ error: 'Cannot delete builtin skills' }, 400);
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

  // --- File serving ---
  app.get('/api/files/:session/:filename', (c) => {
    const sessionId = c.req.param('session');
    const filename = c.req.param('filename');

    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const jid = `${sessionId}@web.nanoclaw`;
    const groups = webChannel.getRegisteredGroups();
    const group = groups[jid];
    if (!group) return c.notFound();

    const filePath = path.join(resolveGroupFolderPath(group.folder), 'uploads', filename);
    if (!fs.existsSync(filePath)) return c.notFound();

    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isImage = contentType.startsWith('image/');

    const data = fs.readFileSync(filePath);
    return new Response(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': isImage ? 'inline' : `attachment; filename="${filename}"`,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  });
}

/** Build channel status list for the settings page. */
export function getChannelStatusList(activeIds: string[] = ['web']) {
  const waActive = activeIds.includes('whatsapp');
  const waAuthExists = fs.existsSync(`${STORE_DIR}/auth/creds.json`);

  // Check if WhatsApp auth flow is in progress
  let waStatus = 'not_configured';
  if (waActive) {
    waStatus = 'connected';
  } else if (waAuthExists) {
    waStatus = 'configured';
  }

  // Override with live auth flow state if active
  const flow = getAuthFlow();
  const flowState = flow.getState();
  if (flowState.status !== 'idle') {
    waStatus = flowState.status;
  }

  const slackActive = activeIds.includes('slack');
  let slackStatus = 'not_configured';
  if (slackActive) {
    slackStatus = 'connected';
  } else if (isChannelConfigured('slack')) {
    slackStatus = 'configured';
  }

  return [
    {
      id: 'web', name: 'Web Chat',
      status: 'connected',
      enabled: true,
      configurable: false,
      guideKeys: ['ch.webGuide.1', 'ch.webGuide.2', 'ch.webGuide.3', 'ch.webGuide.4'],
    },
    {
      id: 'whatsapp', name: 'WhatsApp', status: waStatus,
      enabled: waActive,
      configurable: true,
      guideKeys: ['ch.waGuide.1', 'ch.waGuide.2', 'ch.waGuide.3', 'ch.waGuide.4'],
    },
    {
      id: 'slack', name: 'Slack',
      status: slackStatus,
      enabled: slackActive,
      configurable: true,
      fields: [
        { key: 'bot_token', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...' },
        { key: 'app_token', label: 'App-Level Token', type: 'password', placeholder: 'xapp-...' },
      ],
      config: loadChannelConfigRedacted('slack'),
      guideKeys: ['ch.slackGuide.1', 'ch.slackGuide.2', 'ch.slackGuide.3', 'ch.slackGuide.4', 'ch.slackGuide.5', 'ch.slackGuide.6'],
    },
    {
      id: 'dingtalk', name: 'DingTalk',
      status: activeIds.includes('dingtalk') ? 'connected' : isChannelConfigured('dingtalk') ? 'configured' : 'not_configured',
      enabled: activeIds.includes('dingtalk'),
      configurable: true,
      fields: [
        { key: 'client_id', label: 'Client ID (AppKey)', type: 'text', placeholder: 'dingxxxxxxxx' },
        { key: 'client_secret', label: 'Client Secret (AppSecret)', type: 'password', placeholder: '' },
        { key: 'webhook_url', label: 'Webhook URL (optional)', type: 'text', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
        { key: 'secret', label: 'Webhook Secret (optional)', type: 'password', placeholder: 'SECxxxxxxxx' },
      ],
      config: loadChannelConfigRedacted('dingtalk'),
      guideKeys: ['ch.dtGuide.1', 'ch.dtGuide.2', 'ch.dtGuide.3', 'ch.dtGuide.4', 'ch.dtGuide.5'],
    },
  ];
}
