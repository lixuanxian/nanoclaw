import { DingTalkChannel } from './channels/dingtalk.js';
import { SlackChannel } from './channels/slack.js';
import { WebChannel } from './channels/web.js';
// WhatsApp is lazy-loaded to avoid triggering its registerChannel side-effect
// when the channel is not enabled.
import {
  ADMIN_PASSWORD,
  CREDENTIAL_PROXY_PORT,
  setAdminPassword,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot } from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { initDatabase, storeMessage, storeChatMetadata } from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { broadcastToFolder, findChannel, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage } from './types.js';
import {
  applyAiConfigToEnv,
  loadAdminPassword,
  isChannelConfigured,
  loadEnabledChannels,
  saveEnabledChannels,
} from './channel-config.js';
import { loadCopilotAuth } from './copilot-auth.js';
import { logger } from './logger.js';
import { startWebServer } from './web-server.js';
import {
  loadState,
  registeredGroups,
  registerGroup,
  getAvailableGroups,
  sessions,
} from './state.js';
import {
  processGroupMessages,
  startMessageLoop,
  recoverPendingMessages,
} from './message-loop.js';

let webChannel: WebChannel | undefined;
const channels: Channel[] = [];
const queue = new GroupQueue();

// Channel callbacks (shared by all channels)
const channelOpts = {
  onMessage: (chatJid: string, msg: NewMessage) => {
    // Sender allowlist drop mode: discard messages from denied senders before storing
    if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
      const cfg = loadSenderAllowlist();
      if (
        shouldDropMessage(chatJid, cfg) &&
        !isSenderAllowed(chatJid, msg.sender, cfg)
      ) {
        if (cfg.logDenied) {
          logger.debug(
            { chatJid, sender: msg.sender },
            'sender-allowlist: dropping message (drop mode)',
          );
        }
        return;
      }
    }
    storeMessage(msg);
  },
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
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
      const { WhatsAppChannel } = await import('./channels/whatsapp.js');
      const wa = new WhatsAppChannel(channelOpts);
      channels.push(wa);
      await wa.connect();
    } else if (id === 'slack') {
      const slack = new SlackChannel({ ...channelOpts, registerGroup });
      channels.push(slack);
      await slack.connect();
    } else if (id === 'dingtalk') {
      const dingtalk = new DingTalkChannel({ ...channelOpts, registerGroup });
      channels.push(dingtalk);
      await dingtalk.connect();
    } else if (id === 'qq') {
      const { QQChannel } = await import('./channels/qq.js');
      const qq = new QQChannel({ ...channelOpts, registerGroup });
      channels.push(qq);
      await qq.connect();
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

  // Extract Copilot CLI OAuth token from Windows Credential Manager (if available)
  await loadCopilotAuth();

  // Load saved admin password from config if not set via env
  if (!ADMIN_PASSWORD) {
    const savedPassword = loadAdminPassword();
    if (savedPassword) {
      setAdminPassword(savedPassword);
      logger.info('Admin password loaded from saved config');
    }
  }

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
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
  startWebServer(
    webChannel,
    { startChannelById, stopChannelById, getActiveChannelIds },
    undefined,
    queue,
  );

  // Start skill-registered channels (channels that self-register via barrel import)
  for (const channelName of getRegisteredChannelNames()) {
    if (channels.find((c) => c.name === channelName)) continue; // Already running
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }

  // Start remaining enabled channels (legacy explicit channel management)
  const enabledChannels = loadEnabledChannels();
  for (const id of enabledChannels) {
    if (id === 'web') continue; // Already started above
    if (channels.find((c) => c.name === id)) continue; // Already started by registry
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
    getConnectedChannelIds: () =>
      channels.filter((c) => c.isConnected()).map((c) => c.name),
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (!text) return;
      const group = registeredGroups[jid];
      if (group) {
        await broadcastToFolder(channels, group.folder, registeredGroups, text);
      } else {
        const channel = findChannel(channels, jid);
        if (channel) await channel.sendMessage(jid, text);
        else logger.warn({ jid }, 'No channel owns JID, cannot send message');
      }
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
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn((folder) =>
    processGroupMessages(folder, channels, queue),
  );
  recoverPendingMessages(queue);
  startMessageLoop(channels, queue).catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
import { pathToFileURL } from 'url';
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === pathToFileURL(process.argv[1]).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
