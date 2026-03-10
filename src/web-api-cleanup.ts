import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, DATA_DIR } from './config.js';
import { deleteConversation, getJidsByFolder } from './db.js';
import { getDb } from './db-init.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { registeredGroups } from './state.js';

export interface DeleteInfo {
  folder: string | null;
  isLastJid: boolean;
  hasFiles: boolean;
  taskCount: number;
}

/**
 * Pre-delete info: check if the working directory can be cleaned up.
 */
export function getDeleteInfo(jid: string): DeleteInfo {
  const row = getDb()
    .prepare('SELECT folder FROM registered_groups WHERE jid = ?')
    .get(jid) as { folder: string } | undefined;
  const folder = row?.folder || null;
  if (!folder)
    return { folder: null, isLastJid: true, hasFiles: false, taskCount: 0 };

  const remainingJids = getJidsByFolder(folder).filter((j) => j !== jid);
  const isLastJid = remainingJids.length === 0;

  let hasFiles = false;
  if (isLastJid) {
    try {
      const groupPath = resolveGroupFolderPath(folder);
      hasFiles = fs.existsSync(groupPath);
    } catch {
      /* invalid folder */
    }
  }

  const taskCount = isLastJid
    ? (
        getDb()
          .prepare(
            'SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE group_folder = ?',
          )
          .get(folder) as { cnt: number }
      ).cnt
    : 0;

  return { folder, isLastJid, hasFiles, taskCount };
}

/**
 * Delete conversation with optional working directory cleanup.
 * When deleteFiles is true and no other JIDs share the folder,
 * also removes scheduled tasks, log files, and working directory from disk.
 */
export function deleteConversationFull(
  jid: string,
  deleteFiles: boolean,
): void {
  const row = getDb()
    .prepare('SELECT folder FROM registered_groups WHERE jid = ?')
    .get(jid) as { folder: string } | undefined;
  const folder = row?.folder;

  // Standard DB cleanup (messages, chats, registered_groups, session)
  deleteConversation(jid);

  // Remove from in-memory state
  if (registeredGroups[jid]) {
    delete registeredGroups[jid];
  }

  if (!folder || !deleteFiles) return;

  // Only clean up files if no other JIDs remain on this folder
  const remainingJids = getJidsByFolder(folder);
  if (remainingJids.length > 0) return;

  // Delete scheduled_tasks and task_run_logs for this folder
  const taskIds = getDb()
    .prepare('SELECT id FROM scheduled_tasks WHERE group_folder = ?')
    .all(folder) as Array<{ id: string }>;
  for (const { id } of taskIds) {
    getDb().prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  }
  getDb()
    .prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?')
    .run(folder);

  // Delete filesystem directories
  const dirs = [
    path.resolve(GROUPS_DIR, folder),
    path.resolve(DATA_DIR, 'sessions', folder),
    path.resolve(DATA_DIR, 'ipc', folder),
  ];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        logger.info({ dir }, 'Deleted working directory');
      }
    } catch (err) {
      logger.warn({ dir, err }, 'Failed to delete working directory');
    }
  }
}
