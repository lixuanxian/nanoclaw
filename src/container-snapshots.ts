import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';
import { RegisteredGroup } from './types.js';

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
// --- Channel display names ---
const CHANNEL_DISPLAY_NAMES: Record<string, string> = {
  web: 'Web Chat',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  dingtalk: 'DingTalk',
  telegram: 'Telegram',
};

/** Derive channel ID from a JID string. */
function channelIdFromJid(jid: string): string | null {
  if (jid.endsWith('@web.nanoclaw')) return 'web';
  if (jid.endsWith('@slack.nanoclaw')) return 'slack';
  if (jid.endsWith('@dingtalk.nanoclaw')) return 'dingtalk';
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) return 'whatsapp';
  if (jid.startsWith('tg:')) return 'telegram';
  return null;
}

export interface ChannelSnapshotEntry {
  id: string;
  displayName: string;
  connected: boolean;
  jids: Array<{ jid: string; name: string; folder: string }>;
}

/**
 * Write connected channels snapshot for the container to read.
 * Lists all channels with their registered JIDs so the agent can
 * send cross-channel messages (e.g., "send this to DingTalk").
 */
export function writeChannelsSnapshot(
  groupFolder: string,
  connectedChannelIds: string[],
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const channelMap = new Map<string, ChannelSnapshotEntry>();

  for (const [jid, group] of Object.entries(registeredGroups)) {
    const channelId = channelIdFromJid(jid);
    if (!channelId) continue;

    if (!channelMap.has(channelId)) {
      channelMap.set(channelId, {
        id: channelId,
        displayName: CHANNEL_DISPLAY_NAMES[channelId] || channelId,
        connected: connectedChannelIds.includes(channelId),
        jids: [],
      });
    }

    channelMap.get(channelId)!.jids.push({
      jid,
      name: group.name,
      folder: group.folder,
    });
  }

  const channelsFile = path.join(groupIpcDir, 'connected_channels.json');
  fs.writeFileSync(
    channelsFile,
    JSON.stringify(
      {
        channels: Array.from(channelMap.values()),
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
