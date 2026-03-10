import { ASSISTANT_NAME } from './config.js';
import { getDb } from './db-init.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  return getDb()
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp
  `,
    )
    .all(chatJid) as NewMessage[];
}

/** Return `limit` messages older than `before` timestamp, ordered oldest->newest. */
export function getMessagesBefore(
  chatJid: string,
  before: string,
  limit: number,
): NewMessage[] {
  return getDb()
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ? AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .all(chatJid, before, limit)
    .reverse() as NewMessage[];
}

/** Count total messages for a chat. */
export function countMessagesForChat(chatJid: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE chat_jid = ?')
    .get(chatJid) as { cnt: number };
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
  return getDb()
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid IN (${placeholders})
    ORDER BY timestamp
  `,
    )
    .all(...jids) as NewMessage[];
}

/** Count total messages across multiple JIDs. */
export function countMessagesForJids(jids: string[]): number {
  if (jids.length === 0) return 0;
  const placeholders = jids.map(() => '?').join(',');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE chat_jid IN (${placeholders})`,
    )
    .get(...jids) as { cnt: number };
  return row.cnt;
}

/** Return `limit` messages older than `before` timestamp across multiple JIDs. */
export function getMessagesBeforeMultiJid(
  jids: string[],
  before: string,
  limit: number,
): NewMessage[] {
  if (jids.length === 0) return [];
  const placeholders = jids.map(() => '?').join(',');
  return getDb()
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid IN (${placeholders}) AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .all(...jids, before, limit)
    .reverse() as NewMessage[];
}

// --- Delete / Update ---

/** Delete a single message by its composite PK. FTS5 triggers auto-sync. */
export function deleteMessageById(id: string, chatJid: string): void {
  getDb()
    .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
    .run(id, chatJid);
}

/** Update the content of a single message. FTS5 triggers auto-sync. */
export function updateMessageContent(
  id: string,
  chatJid: string,
  content: string,
): void {
  getDb()
    .prepare('UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?')
    .run(content, id, chatJid);
}

/** Delete all messages in a chat that come after a given timestamp. Returns number deleted. */
export function deleteMessagesAfter(
  chatJid: string,
  afterTimestamp: string,
): number {
  const result = getDb()
    .prepare('DELETE FROM messages WHERE chat_jid = ? AND timestamp > ?')
    .run(chatJid, afterTimestamp);
  return result.changes;
}

/** Get the timestamp of a message by its composite PK. */
export function getMessageTimestamp(
  id: string,
  chatJid: string,
): string | null {
  const row = getDb()
    .prepare('SELECT timestamp FROM messages WHERE id = ? AND chat_jid = ?')
    .get(id, chatJid) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

// --- Full-text search ---

export interface SearchResult {
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
  snippet: string;
}

/** Check if a string contains CJK characters (Chinese, Japanese, Korean). */
function hasCJK(text: string): boolean {
  // CJK Unified Ideographs, Hiragana, Katakana, Hangul, CJK extensions
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/.test(text);
}

/** Escape a string for safe use in SQL LIKE patterns. */
function escapeLike(text: string): string {
  return text.replace(/[%_\\]/g, '\\$&');
}

/** Build a snippet with <mark> highlighting around the matched term. */
function highlightSnippet(
  content: string,
  query: string,
  contextChars = 60,
): string {
  const lower = content.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) {
    return content.length > contextChars * 2
      ? content.slice(0, contextChars * 2) + '...'
      : content;
  }
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(content.length, idx + query.length + contextChars);
  const before = (start > 0 ? '...' : '') + content.slice(start, idx);
  const match = content.slice(idx, idx + query.length);
  const after =
    content.slice(idx + query.length, end) +
    (end < content.length ? '...' : '');
  return `${before}<mark>${match}</mark>${after}`;
}

/** LIKE-based search for CJK text where FTS5 unicode61 tokenizer fails. */
function searchMessagesLike(
  query: string,
  jids: string[] | undefined,
  limit: number,
  offset: number,
): SearchResult[] {
  const db = getDb();
  const pattern = `%${escapeLike(query)}%`;
  const params: unknown[] = [];

  let jidFilter = '';
  if (jids && jids.length > 0) {
    const placeholders = jids.map(() => '?').join(',');
    jidFilter = `AND m.chat_jid IN (${placeholders})`;
    params.push(...jids);
  }

  const sql = `
    SELECT m.id, m.chat_jid, m.sender_name, m.content, m.timestamp, m.is_bot_message
    FROM messages m
    WHERE (m.content LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\')
      ${jidFilter}
    ORDER BY m.timestamp DESC
    LIMIT ? OFFSET ?
  `;
  params.unshift(pattern, pattern);
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Omit<
    SearchResult,
    'snippet'
  >[];
  return rows.map((r) => ({
    ...r,
    snippet: highlightSnippet(r.content, query),
  }));
}

/** Full-text search across messages. Optionally scoped to specific JIDs. */
export function searchMessages(
  query: string,
  jids?: string[],
  limit = 20,
  offset = 0,
): SearchResult[] {
  // CJK text: unicode61 tokenizer can't segment properly, use LIKE instead
  if (hasCJK(query)) {
    return searchMessagesLike(query, jids, limit, offset);
  }

  const db = getDb();

  // Escape FTS5 special characters and operators
  const safeQuery = query
    .replace(/['"*(){}[\]^~:\\+\-]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .trim();
  if (!safeQuery) return [];

  let sql: string;
  const params: unknown[] = [];

  if (jids && jids.length > 0) {
    const placeholders = jids.map(() => '?').join(',');
    sql = `
      SELECT m.id, m.chat_jid, m.sender_name, m.content, m.timestamp, m.is_bot_message,
             snippet(messages_fts, 0, '<mark>', '</mark>', '...', 64) as snippet
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
        AND m.chat_jid IN (${placeholders})
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;
    params.push(safeQuery, ...jids, limit, offset);
  } else {
    sql = `
      SELECT m.id, m.chat_jid, m.sender_name, m.content, m.timestamp, m.is_bot_message,
             snippet(messages_fts, 0, '<mark>', '</mark>', '...', 64) as snippet
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;
    params.push(safeQuery, limit, offset);
  }

  try {
    return db.prepare(sql).all(...params) as SearchResult[];
  } catch (err) {
    logger.warn(
      { err, query: safeQuery },
      'FTS5 search failed, falling back to LIKE',
    );
    return searchMessagesLike(query, jids, limit, offset);
  }
}
