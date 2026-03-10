import fs from 'fs';
import path from 'path';

import {
  getAllRegisteredGroups,
  getAllSessions,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { getAllChats } from './db.js';
import type { AvailableGroup } from './container-snapshots.js';

export let lastTimestamp = '';
export let sessions: Record<string, string> = {};
export let registeredGroups: Record<string, RegisteredGroup> = {};
/** Keyed by folder (not JID) — tracks which messages have been processed per sync group. */
export let lastAgentTimestamp: Record<string, string> = {};

export function setLastTimestamp(value: string): void {
  lastTimestamp = value;
}

export function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  let rawTimestamps: Record<string, string> = {};
  try {
    rawTimestamps = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    rawTimestamps = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Migrate JID-keyed timestamps to folder-keyed (cross-channel sync migration)
  lastAgentTimestamp = migrateAgentTimestamps(rawTimestamps, registeredGroups);

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Convert lastAgentTimestamp from JID-keyed to folder-keyed.
 * If keys are already folder-based (not containing '@'), keep as-is.
 * For JID keys, look up the folder and take MAX timestamp per folder.
 */
function migrateAgentTimestamps(
  raw: Record<string, string>,
  groups: Record<string, RegisteredGroup>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, ts] of Object.entries(raw)) {
    // If key contains '@', it's a JID — convert to folder
    if (key.includes('@')) {
      const group = groups[key];
      if (!group) continue;
      const folder = group.folder;
      if (!result[folder] || ts > result[folder]) {
        result[folder] = ts;
      }
    } else {
      // Already folder-keyed
      if (!result[key] || ts > result[key]) {
        result[key] = ts;
      }
    }
  }
  return result;
}

export function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/** Get all JIDs that share a given folder (from in-memory registeredGroups). */
export function getJidsForFolder(folder: string): string[] {
  return Object.entries(registeredGroups)
    .filter(([_, g]) => g.folder === folder)
    .map(([jid]) => jid);
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}
