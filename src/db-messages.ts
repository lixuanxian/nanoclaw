import { ASSISTANT_NAME } from './config.js';
import { getDb } from './db-init.js';
import { NewMessage } from './types.js';

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  const rows = getDb()
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  return getDb()
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

/** Get all messages for a chat (both user and bot), ordered chronologically. */
export function getAllMessagesForChat(chatJid: string): NewMessage[] {
  return getDb().prepare(`
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp
  `).all(chatJid) as NewMessage[];
}

/** Return `limit` messages older than `before` timestamp, ordered oldest->newest. */
export function getMessagesBefore(chatJid: string, before: string, limit: number): NewMessage[] {
  return getDb().prepare(`
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ? AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatJid, before, limit).reverse() as NewMessage[];
}

/** Count total messages for a chat. */
export function countMessagesForChat(chatJid: string): number {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM messages WHERE chat_jid = ?').get(chatJid) as { cnt: number };
  return row.cnt;
}

// --- Multi-JID variants for cross-channel sync ---

/** Get pending user messages across multiple JIDs (for folder-based aggregation). */
export function getMessagesSinceMultiJid(
  jids: string[],
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  if (jids.length === 0) return [];
  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid IN (${placeholders}) AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  return getDb()
    .prepare(sql)
    .all(...jids, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

/** Get all messages (user + bot) across multiple JIDs, sorted chronologically. */
export function getAllMessagesForJids(jids: string[]): NewMessage[] {
  if (jids.length === 0) return [];
  const placeholders = jids.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid IN (${placeholders})
    ORDER BY timestamp
  `).all(...jids) as NewMessage[];
}

/** Count total messages across multiple JIDs. */
export function countMessagesForJids(jids: string[]): number {
  if (jids.length === 0) return 0;
  const placeholders = jids.map(() => '?').join(',');
  const row = getDb().prepare(
    `SELECT COUNT(*) as cnt FROM messages WHERE chat_jid IN (${placeholders})`,
  ).get(...jids) as { cnt: number };
  return row.cnt;
}

/** Return `limit` messages older than `before` timestamp across multiple JIDs. */
export function getMessagesBeforeMultiJid(jids: string[], before: string, limit: number): NewMessage[] {
  if (jids.length === 0) return [];
  const placeholders = jids.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid IN (${placeholders}) AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...jids, before, limit).reverse() as NewMessage[];
}
