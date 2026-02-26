import { DingTalkChannel } from './channels/dingtalk.js';
import { SlackChannel } from './channels/slack.js';
import { WebChannel } from './channels/web.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { writeGroupsSnapshot } from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import { initDatabase, storeMessage, storeChatMetadata } from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { broadcastToFolder, findChannel, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage } from './types.js';
import { applyAiConfigToEnv, isChannelConfigured, loadEnabledChannels, saveEnabledChannels } from './channel-config.js';
import { logger } from './logger.js';
import { startWebServer } from './web-server.js';
import {
  loadState,
  registeredGroups,
  registerGroup,
  getAvailableGroups,
  sessions,
} from './state.js';
import { processGroupMessages, startMessageLoop, recoverPendingMessages } from './message-loop.js';

let whatsapp: WhatsAppChannel | undefined;
let webChannel: WebChannel | undefined;
const channels: Channel[] = [];
const queue = new GroupQueue();

// Channel callbacks (shared by all channels)
const channelOpts = {
  onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
  onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
    storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
  registeredGroups: () => registeredGroups,
};

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/** Start a channel by ID at runtime. Returns error message on failure, null on success. */
export async function startChannelById(id: string): Promise<string | null> {
  // Check if already running
  if (id === 'web') return null; // Web is always running
  if (channels.find((c) => c.name === id)) return null; // Already active

  // Skip channels that haven't been configured yet
  if (!isChannelConfigured(id)) {
    logger.debug({ channel: id }, 'Channel not configured, skipping');
    return `Channel ${id} is not configured. Set it up in Settings first.`;
  }

  try {
    if (id === 'whatsapp') {
      whatsapp = new WhatsAppChannel(channelOpts);
      channels.push(whatsapp);
      await whatsapp.connect();
    } else if (id === 'slack') {
      const slack = new SlackChannel({ ...channelOpts, registerGroup });
      channels.push(slack);
      await slack.connect();
    } else if (id === 'dingtalk') {
      const dingtalk = new DingTalkChannel({ ...channelOpts, registerGroup });
      channels.push(dingtalk);
      await dingtalk.connect();
    } else {
      return `Unknown channel: ${id}`;
    }

    // Persist enabled channels
    const active = channels.map((c) => c.name);
    saveEnabledChannels(active);
    logger.info({ channel: id }, 'Channel started at runtime');
    return null;
  } catch (err) {
    // Remove failed channel from array
    const idx = channels.findIndex((c) => c.name === id);
    if (idx !== -1) channels.splice(idx, 1);
    if (id === 'whatsapp') whatsapp = undefined;

    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ channel: id, err }, 'Failed to start channel');
    return msg;
  }
}

/** Stop a channel by ID at runtime. Returns error message on failure, null on success. */
export async function stopChannelById(id: string): Promise<string | null> {
  if (id === 'web') return 'Cannot stop the web channel';

  const idx = channels.findIndex((c) => c.name === id);
  if (idx === -1) return null; // Already stopped

  try {
    await channels[idx].disconnect();
    channels.splice(idx, 1);
    if (id === 'whatsapp') whatsapp = undefined;

    // Persist enabled channels
    const active = channels.map((c) => c.name);
    saveEnabledChannels(active);
    logger.info({ channel: id }, 'Channel stopped at runtime');
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ channel: id, err }, 'Failed to stop channel');
    return msg;
  }
}

/** Get list of currently active channel IDs. */
export function getActiveChannelIds(): string[] {
  return channels.map((c) => c.name);
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Apply saved AI provider API keys to process.env
  applyAiConfigToEnv();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Web channel is always started
  webChannel = new WebChannel({
    ...channelOpts,
    registerGroup,
  });
  channels.push(webChannel);
  await webChannel.connect();
  startWebServer(webChannel, { startChannelById, stopChannelById, getActiveChannelIds }, undefined, queue);

  // Start remaining enabled channels
  const enabledChannels = loadEnabledChannels();
  for (const id of enabledChannels) {
    if (id === 'web') continue; // Already started above
    await startChannelById(id);
  }

  if (channels.length === 0) {
    logger.fatal('No channels started successfully');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (folder, proc, containerName) => queue.registerProcess(folder, proc, containerName),
    sendMessage: async (folder, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await broadcastToFolder(channels, folder, registeredGroups, text);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const group = registeredGroups[jid];
      if (group) {
        await broadcastToFolder(channels, group.folder, registeredGroups, text);
      } else {
        const channel = findChannel(channels, jid);
        if (!channel) throw new Error(`No channel for JID: ${jid}`);
        await channel.sendMessage(jid, text);
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn((folder) => processGroupMessages(folder, channels, queue));
  recoverPendingMessages(queue);
  startMessageLoop(channels, queue).catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
