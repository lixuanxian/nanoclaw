import { Hono } from 'hono';

import { extractSearchKeywords } from './ai-search.js';
import { ASSISTANT_NAME, TIMEZONE } from './config.js';
import { getAllRegisteredGroups, setRegisteredGroup, getAllTasks, getTasksForGroup, createTask, updateTask, deleteTask, getTaskById, getTaskRunLogs, getAllMessagesForJids, getJidsByFolder, searchMessages } from './db.js';
import { logger } from './logger.js';
import { registeredGroups } from './state.js';

/** Register groups and tasks API routes on the Hono app. */
export function registerGroupRoutes(app: Hono): void {
  // --- Registered groups API ---
  app.get('/api/groups', (c) => {
    const groups = getAllRegisteredGroups();
    const list = Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      trigger: g.trigger,
      added_at: g.added_at,
      requiresTrigger: g.requiresTrigger ?? true,
      containerConfig: g.containerConfig || null,
    }));
    return c.json({ groups: list });
  });

  app.put('/api/groups/:jid', async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const body = await c.req.json<{
      name?: string;
      trigger?: string;
      requiresTrigger?: boolean;
      containerConfig?: { provider?: string; model?: string } | null;
    }>();
    const groups = getAllRegisteredGroups();
    const existing = groups[jid];
    if (!existing) return c.json({ error: 'Group not found' }, 404);

    const updated = {
      ...existing,
      name: body.name ?? existing.name,
      trigger: body.trigger ?? existing.trigger,
      requiresTrigger: body.requiresTrigger ?? existing.requiresTrigger,
      containerConfig: body.containerConfig !== undefined
        ? (body.containerConfig ?? undefined)
        : existing.containerConfig,
    };
    setRegisteredGroup(jid, updated);

    // Sync in-memory state so message-loop picks up changes immediately
    if (registeredGroups[jid]) {
      registeredGroups[jid] = updated;
    }

    logger.info({ jid }, 'Group updated via API');
    return c.json({ ok: true });
  });

  // --- Scheduled tasks API ---
  app.get('/api/tasks', (c) => {
    const folder = c.req.query('folder');
    const tasks = folder ? getTasksForGroup(folder) : getAllTasks();
    return c.json({ tasks });
  });

  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{
      group_folder: string;
      chat_jid: string;
      prompt: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      context_mode?: 'group' | 'isolated';
    }>();
    if (!body.prompt || !body.schedule_type || !body.schedule_value || !body.group_folder || !body.chat_jid) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    let nextRun: string | null = null;
    try {
      if (body.schedule_type === 'cron') {
        const { CronExpressionParser } = await import('cron-parser');
        const interval = CronExpressionParser.parse(body.schedule_value, { tz: TIMEZONE });
        nextRun = interval.next().toISOString();
      } else if (body.schedule_type === 'interval') {
        const ms = parseInt(body.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) return c.json({ error: 'Invalid interval value' }, 400);
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (body.schedule_type === 'once') {
        const d = new Date(body.schedule_value);
        if (isNaN(d.getTime())) return c.json({ error: 'Invalid date value' }, 400);
        nextRun = d.toISOString();
      }
    } catch (err) {
      return c.json({ error: `Invalid schedule: ${err instanceof Error ? err.message : err}` }, 400);
    }

    const id = crypto.randomUUID();
    createTask({
      id,
      group_folder: body.group_folder,
      chat_jid: body.chat_jid,
      prompt: body.prompt,
      schedule_type: body.schedule_type,
      schedule_value: body.schedule_value,
      context_mode: body.context_mode || 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info({ taskId: id }, 'Task created via API');
    return c.json({ ok: true, id });
  });

  app.put('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getTaskById(id);
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    const body = await c.req.json<{
      prompt?: string;
      schedule_type?: 'cron' | 'interval' | 'once';
      schedule_value?: string;
      status?: 'active' | 'paused';
      context_mode?: 'group' | 'isolated';
    }>();

    const updates: Parameters<typeof updateTask>[1] = {};
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.status !== undefined) updates.status = body.status;
    if (body.context_mode !== undefined) updates.context_mode = body.context_mode;

    // Recalculate next_run if schedule changed
    if (body.schedule_type || body.schedule_value) {
      const sType = body.schedule_type || existing.schedule_type;
      const sVal = body.schedule_value || existing.schedule_value;
      updates.schedule_type = sType;
      updates.schedule_value = sVal;

      try {
        if (sType === 'cron') {
          const { CronExpressionParser } = await import('cron-parser');
          const interval = CronExpressionParser.parse(sVal, { tz: TIMEZONE });
          updates.next_run = interval.next().toISOString();
        } else if (sType === 'interval') {
          const ms = parseInt(sVal, 10);
          updates.next_run = new Date(Date.now() + ms).toISOString();
        } else if (sType === 'once') {
          updates.next_run = new Date(sVal).toISOString();
        }
      } catch (err) {
        return c.json({ error: `Invalid schedule: ${err instanceof Error ? err.message : err}` }, 400);
      }
    }

    updateTask(id, updates);
    logger.info({ taskId: id }, 'Task updated via API');
    return c.json({ ok: true });
  });

  app.delete('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    deleteTask(id);
    logger.info({ taskId: id }, 'Task deleted via API');
    return c.json({ ok: true });
  });

  app.get('/api/tasks/:id/logs', (c) => {
    const id = c.req.param('id');
    const task = getTaskById(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const logs = getTaskRunLogs(id);
    return c.json({ task, logs });
  });

  // --- Message search ---
  app.get('/api/search', (c) => {
    const q = c.req.query('q');
    if (!q || q.trim().length === 0) return c.json({ results: [] });

    const jid = c.req.query('jid');
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    let jids: string[] | undefined;
    if (jid) {
      const groups = getAllRegisteredGroups();
      const group = groups[jid];
      const folder = group?.folder;
      jids = folder ? getJidsByFolder(folder) : [jid];
    }

    const results = searchMessages(q, jids, limit, offset);
    return c.json({
      results: results.map((r) => ({
        id: r.id,
        chatJid: r.chat_jid,
        sender: r.sender_name,
        content: r.content,
        timestamp: r.timestamp,
        isBot: !!r.is_bot_message,
        snippet: r.snippet,
      })),
    });
  });

  // --- AI-powered search ---
  app.get('/api/search/ai', async (c) => {
    const q = c.req.query('q');
    if (!q || q.trim().length === 0) return c.json({ results: [], aiKeywords: '' });

    const jid = c.req.query('jid');
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const lang = c.req.query('lang') || 'en';
    const { keywords, error } = await extractSearchKeywords(q.trim(), lang);

    let jids: string[] | undefined;
    if (jid) {
      const groups = getAllRegisteredGroups();
      const group = groups[jid];
      const folder = group?.folder;
      jids = folder ? getJidsByFolder(folder) : [jid];
    }

    const results = searchMessages(keywords, jids, limit, offset);
    return c.json({
      aiKeywords: keywords,
      error: error || undefined,
      results: results.map((r) => ({
        id: r.id,
        chatJid: r.chat_jid,
        sender: r.sender_name,
        content: r.content,
        timestamp: r.timestamp,
        isBot: !!r.is_bot_message,
        snippet: r.snippet,
      })),
    });
  });

  // --- Conversation export ---
  app.get('/api/export/:jid', (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const format = (c.req.query('format') || 'json') as 'json' | 'md' | 'csv';

    const groups = getAllRegisteredGroups();
    const group = groups[jid];
    const folder = group?.folder;
    const allJids = folder ? getJidsByFolder(folder) : [jid];
    const messages = getAllMessagesForJids(allJids);

    if (messages.length === 0) return c.json({ error: 'No messages found' }, 404);

    const name = group?.name || jid;
    const datestamp = new Date().toISOString().slice(0, 10);

    if (format === 'md') {
      const lines: string[] = [`# ${name}\n`, `Exported: ${new Date().toISOString()}\n`];
      for (const m of messages) {
        const sender = m.is_bot_message ? ASSISTANT_NAME : m.sender_name;
        const time = new Date(m.timestamp).toLocaleString();
        lines.push(`### ${sender} (${time})\n`, m.content + '\n', '---\n');
      }
      return new Response(lines.join('\n'), {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}-${datestamp}.md"`,
        },
      });
    }

    if (format === 'csv') {
      const esc = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
      const header = 'timestamp,sender,content,chat_jid,is_bot';
      const rows = messages.map((m) =>
        [m.timestamp, esc(m.sender_name), esc(m.content), m.chat_jid, m.is_bot_message ? '1' : '0'].join(','),
      );
      return new Response([header, ...rows].join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}-${datestamp}.csv"`,
        },
      });
    }

    const json = JSON.stringify({
      exportedAt: new Date().toISOString(),
      conversation: name,
      folder: folder || null,
      messageCount: messages.length,
      messages: messages.map((m) => ({
        id: m.id,
        chatJid: m.chat_jid,
        sender: m.sender_name,
        content: m.content,
        timestamp: m.timestamp,
        isBot: !!m.is_bot_message,
      })),
    }, null, 2);

    return new Response(json, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}-${datestamp}.json"`,
      },
    });
  });
}
