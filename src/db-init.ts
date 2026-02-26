import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { setRouterState, setSession, setRegisteredGroup } from './db-groups.js';

let db: Database.Database;

/** Get the shared database instance (must call initDatabase first). */
export function getDb(): Database.Database {
  return db;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_rg_folder ON registered_groups(folder);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
    ).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Remove UNIQUE constraint on registered_groups.folder (allow cross-channel sync)
  // SQLite doesn't support DROP CONSTRAINT, so we recreate the table
  try {
    const hasUnique = database.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='registered_groups'`,
    ).get() as { sql: string } | undefined;
    if (hasUnique?.sql?.includes('UNIQUE')) {
      database.exec(`
        CREATE TABLE registered_groups_new (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1
        );
        INSERT INTO registered_groups_new SELECT * FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_new RENAME TO registered_groups;
        CREATE INDEX IF NOT EXISTS idx_rg_folder ON registered_groups(folder);
      `);
      logger.info('Migrated registered_groups: removed UNIQUE constraint on folder');
    }
  } catch {
    /* already migrated or fresh DB */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN channel TEXT`,
    );
    database.exec(
      `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
    );
    // Backfill from JID patterns
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`);
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`);
  } catch {
    /* columns already exist */
  }

  // FTS5 full-text search index for messages
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        sender_name,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61'
      );
    `);

    // Sync triggers
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, sender_name)
        VALUES (new.rowid, new.content, new.sender_name);
      END;
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
        VALUES ('delete', old.rowid, old.content, old.sender_name);
      END;
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
        VALUES ('delete', old.rowid, old.content, old.sender_name);
        INSERT INTO messages_fts(rowid, content, sender_name)
        VALUES (new.rowid, new.content, new.sender_name);
      END;
    `);

    // Backfill existing messages (only if FTS table is empty)
    const ftsCount = database.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number };
    if (ftsCount.cnt === 0) {
      const msgCount = database.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number };
      if (msgCount.cnt > 0) {
        database.exec(`
          INSERT INTO messages_fts(rowid, content, sender_name)
          SELECT rowid, content, sender_name FROM messages;
        `);
        logger.info({ count: msgCount.cnt }, 'Backfilled FTS index');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'FTS5 setup failed, search will be unavailable');
  }
}

/**
 * Drop and recreate the FTS5 index. Call this to recover from corruption.
 * Drops triggers first so concurrent deletes don't crash.
 */
export function rebuildFtsIndex(): void {
  const database = getDb();
  logger.warn('Rebuilding FTS5 index due to corruption');

  // Drop triggers first to prevent cascading errors
  database.exec('DROP TRIGGER IF EXISTS messages_fts_ai');
  database.exec('DROP TRIGGER IF EXISTS messages_fts_ad');
  database.exec('DROP TRIGGER IF EXISTS messages_fts_au');
  database.exec('DROP TABLE IF EXISTS messages_fts');

  // Recreate
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, sender_name,
      content='messages', content_rowid='rowid',
      tokenize='unicode61'
    );
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, sender_name)
      VALUES (new.rowid, new.content, new.sender_name);
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
      VALUES ('delete', old.rowid, old.content, old.sender_name);
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, sender_name)
      VALUES ('delete', old.rowid, old.content, old.sender_name);
      INSERT INTO messages_fts(rowid, content, sender_name)
      VALUES (new.rowid, new.content, new.sender_name);
    END;
  `);

  // Backfill
  const msgCount = database.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number };
  if (msgCount.cnt > 0) {
    database.exec(`
      INSERT INTO messages_fts(rowid, content, sender_name)
      SELECT rowid, content, sender_name FROM messages;
    `);
  }
  logger.info({ messages: msgCount.cnt }, 'FTS5 index rebuilt successfully');
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
