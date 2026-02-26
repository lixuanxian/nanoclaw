import { getDb } from './db-init.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    getDb().prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    getDb().prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  getDb().prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return getDb()
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = getDb()
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = getDb()
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  getDb().prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = getDb()
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

/** Get all JIDs that share a given folder (for cross-channel sync). */
export function getJidsByFolder(folder: string): string[] {
  const rows = getDb().prepare(
    'SELECT jid FROM registered_groups WHERE folder = ?',
  ).all(folder) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

// --- Web session listing ---

export interface WebSessionInfo {
  sessionId: string;
  name: string;
  lastMessageTime: string | null;
  preview: string | null;
}

/** List all web chat sessions with last activity and message preview.
 *  For synced folders (shared by multiple channels), shows the latest message
 *  across all JIDs in the folder. */
export function getWebSessions(): WebSessionInfo[] {
  const rows = getDb().prepare(`
    SELECT rg.jid, rg.name, rg.folder, rg.added_at,
      c.last_message_time,
      (SELECT content FROM messages m
       INNER JOIN registered_groups rg2 ON m.chat_jid = rg2.jid
       WHERE rg2.folder = rg.folder
       ORDER BY m.timestamp DESC LIMIT 1) as last_content
    FROM registered_groups rg
    LEFT JOIN chats c ON c.jid = rg.jid
    WHERE rg.jid LIKE '%@web.nanoclaw'
    ORDER BY COALESCE(c.last_message_time, rg.added_at) DESC
  `).all() as Array<{
    jid: string;
    name: string;
    folder: string;
    added_at: string;
    last_message_time: string | null;
    last_content: string | null;
  }>;

  return rows.map(r => {
    const sessionId = r.jid.replace('@web.nanoclaw', '');
    let preview = r.last_content;
    if (preview && preview.length > 80) preview = preview.slice(0, 80) + '...';
    return {
      sessionId,
      name: r.name,
      lastMessageTime: r.last_message_time || r.added_at,
      preview,
    };
  });
}

/** Delete all data for a web session. */
export function deleteWebSession(sessionId: string): void {
  const jid = `${sessionId}@web.nanoclaw`;
  deleteConversation(jid);
}

// --- All-channel conversation listing ---

export interface ConversationInfo {
  jid: string;
  name: string;
  channel: string;
  lastMessageTime: string | null;
  preview: string | null;
}

function channelFromJid(jid: string): string {
  if (jid.includes('@web.')) return 'web';
  if (jid.includes('@slack.')) return 'slack';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  return 'unknown';
}

/** List all conversations across all channels. */
export function getAllConversations(): ConversationInfo[] {
  const rows = getDb().prepare(`
    SELECT rg.jid, rg.name, rg.folder, rg.added_at,
      c.last_message_time,
      (SELECT content FROM messages m
       INNER JOIN registered_groups rg2 ON m.chat_jid = rg2.jid
       WHERE rg2.folder = rg.folder
       ORDER BY m.timestamp DESC LIMIT 1) as last_content
    FROM registered_groups rg
    LEFT JOIN chats c ON c.jid = rg.jid
    ORDER BY COALESCE(c.last_message_time, rg.added_at) DESC
  `).all() as Array<{
    jid: string;
    name: string;
    folder: string;
    added_at: string;
    last_message_time: string | null;
    last_content: string | null;
  }>;

  return rows.map(r => {
    let preview = r.last_content;
    if (preview && preview.length > 80) preview = preview.slice(0, 80) + '...';
    return {
      jid: r.jid,
      name: r.name,
      channel: channelFromJid(r.jid),
      lastMessageTime: r.last_message_time || r.added_at,
      preview,
    };
  });
}

/** Delete all data for a conversation (any channel). */
export function deleteConversation(jid: string): void {
  const row = getDb().prepare('SELECT folder FROM registered_groups WHERE jid = ?').get(jid) as { folder: string } | undefined;
  const folder = row?.folder;

  getDb().prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
  getDb().prepare('DELETE FROM chats WHERE jid = ?').run(jid);
  getDb().prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);

  if (folder) {
    const remainingJids = getJidsByFolder(folder);
    if (remainingJids.length === 0) {
      getDb().prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    }
  }
}
