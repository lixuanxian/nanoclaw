import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getMessagesSinceMultiJid,
  getNewMessages,
  setSession,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { broadcastToFolder, findChannel, formatMessages } from './router.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { loadDefaultProviderConfig } from './channel-config.js';
import { getProvider } from './providers.js';
import { getSkillContents } from './skills.js';
import { logger } from './logger.js';
import { WebChannel } from './channels/web.js';
import {
  lastAgentTimestamp,
  lastTimestamp as _lastTimestamp,
  registeredGroups,
  sessions,
  saveState,
  getAvailableGroups,
  getJidsForFolder,
} from './state.js';

// We need mutable access — re-export module-level refs from state.ts
// For mutable access to state module variables, we import the module itself
import * as state from './state.js';

let messageLoopRunning = false;

/**
 * Process all pending messages for a folder (sync group).
 * Called by the GroupQueue when it's this folder's turn.
 * Aggregates messages from ALL JIDs sharing the folder.
 */
export async function processGroupMessages(
  folder: string,
  channels: Channel[],
  queue: GroupQueue,
): Promise<boolean> {
  const allJids = getJidsForFolder(folder);
  if (allJids.length === 0) return true;

  // Use first registered JID's group for config (provider, trigger, etc.)
  const primaryJid = allJids[0];
  const group = state.registeredGroups[primaryJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Aggregate messages from ALL JIDs in the folder
  const sinceTimestamp = state.lastAgentTimestamp[folder] || '';
  const missedMessages = getMessagesSinceMultiJid(allJids, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // For resumed sessions with a single message, send raw text to avoid
  // redundant XML wrapping — the session already has context.
  const hasSession = !!state.sessions[group.folder];
  const prompt = (hasSession && missedMessages.length === 1)
    ? missedMessages[0].content
    : formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = state.lastAgentTimestamp[folder] || '';
  state.lastAgentTimestamp[folder] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, folder, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ folder }, 'Idle timeout, closing container stdin');
      queue.closeStdin(folder);
    }, IDLE_TIMEOUT);
  };

  // Broadcast typing indicator to all channels
  for (const jid of allJids) {
    const ch = findChannel(channels, jid);
    ch?.setTyping?.(jid, true)?.catch(() => {});
  }

  // Extract mode/skills from web session (if this folder has a web JID)
  const webJid = allJids.find((j) => j.endsWith('@web.nanoclaw'));
  let sessionMode: 'plan' | 'edit' | undefined;
  let sessionSkills: string[] | undefined;
  if (webJid) {
    const webCh = channels.find((c) => c.name === 'web') as WebChannel | undefined;
    if (webCh) {
      const sid = webJid.replace('@web.nanoclaw', '');
      sessionMode = webCh.getSessionMode(sid);
      sessionSkills = webCh.getSessionSkills(sid);
    }
  }

  let hadError = false;
  let outputSentToUser = false;
  let lastError: string | undefined;

  const output = await runAgent(
    group, prompt, folder, queue,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          // Broadcast response to ALL channels sharing this folder
          await broadcastToFolder(channels, folder, state.registeredGroups, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(folder);
      }

      if (result.status === 'error') {
        hadError = true;
        lastError = result.error;
      }
    },
    { mode: sessionMode, skills: sessionSkills },
  );

  // Clear typing indicator on all channels
  for (const jid of allJids) {
    const ch = findChannel(channels, jid);
    ch?.setTyping?.(jid, false)?.catch(() => {});
  }
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Send error to user so they know what went wrong (instead of silent failure)
    if (!outputSentToUser && lastError) {
      const shortError = lastError.length > 300 ? lastError.slice(0, 300) + '...' : lastError;
      await broadcastToFolder(channels, folder, state.registeredGroups, `Error: ${shortError}`);
      outputSentToUser = true;
    }

    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    state.lastAgentTimestamp[folder] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  folder: string,
  queue: GroupQueue,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  options?: { mode?: 'plan' | 'edit'; skills?: string[] },
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = state.sessions[group.folder];

  // Use the first JID in the folder for chatJid (container authorization)
  const allJids = getJidsForFolder(folder);
  const chatJid = allJids[0] || folder;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(state.registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          state.sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Resolve AI provider: session config -> global default -> 'claude'
  const defaultCfg = loadDefaultProviderConfig();
  const providerId = group.containerConfig?.provider || defaultCfg.provider;
  const providerConfig = getProvider(providerId);
  const modelId = group.containerConfig?.model || defaultCfg.model || providerConfig?.defaultModel;
  const apiBase = defaultCfg.api_base || providerConfig?.apiBase || '';

  // Inject mode instruction and skill content into prompt
  let finalPrompt = prompt;
  if (options?.mode === 'plan') {
    finalPrompt = '[MODE: PLAN] Before executing, first outline your plan and approach step by step. Explain what you will do and why. Then proceed with implementation.\n\n' + finalPrompt;
  }
  if (options?.skills && options.skills.length > 0) {
    const skillContents = getSkillContents(options.skills);
    if (skillContents.length > 0) {
      const skillBlock = skillContents
        .map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
        .join('\n\n');
      finalPrompt = skillBlock + '\n\n' + finalPrompt;
    }
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: finalPrompt,
        sessionId: (providerId === 'claude' || providerId === 'claude-compatible') ? sessionId : undefined,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        provider: providerId,
        model: modelId,
        providerApiBase: apiBase,
      },
      (proc, containerName) => queue.registerProcess(folder, proc, containerName),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      state.sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

export async function startMessageLoop(
  channels: Channel[],
  queue: GroupQueue,
): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(state.registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, state.lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        state.setLastTimestamp(newTimestamp);
        saveState();

        // Group messages by FOLDER (not JID) for cross-channel sync
        const messagesByFolder = new Map<string, { jids: Set<string>; messages: NewMessage[] }>();
        for (const msg of messages) {
          const group = state.registeredGroups[msg.chat_jid];
          if (!group) continue;
          const folder = group.folder;

          let entry = messagesByFolder.get(folder);
          if (!entry) {
            entry = { jids: new Set(), messages: [] };
            messagesByFolder.set(folder, entry);
          }
          entry.jids.add(msg.chat_jid);
          entry.messages.push(msg);
        }

        for (const [folder, { messages: folderMessages }] of messagesByFolder) {
          // Get any group entry for this folder to check trigger requirements
          const allJids = getJidsForFolder(folder);
          const primaryJid = allJids[0];
          const group = primaryJid ? state.registeredGroups[primaryJid] : undefined;
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = folderMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSinceMultiJid(
            allJids,
            state.lastAgentTimestamp[folder] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : folderMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(folder, formatted)) {
            logger.debug(
              { folder, count: messagesToSend.length },
              'Piped messages to active container',
            );
            state.lastAgentTimestamp[folder] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator on all channels while the container processes
            for (const jid of allJids) {
              const ch = findChannel(channels, jid);
              ch?.setTyping?.(jid, true)?.catch((err) =>
                logger.warn({ jid, err }, 'Failed to set typing indicator'),
              );
            }
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(folder);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
export function recoverPendingMessages(queue: GroupQueue): void {
  const processedFolders = new Set<string>();
  for (const [, group] of Object.entries(state.registeredGroups)) {
    if (processedFolders.has(group.folder)) continue;
    processedFolders.add(group.folder);

    const allJids = getJidsForFolder(group.folder);
    const sinceTimestamp = state.lastAgentTimestamp[group.folder] || '';
    const pending = getMessagesSinceMultiJid(allJids, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, folder: group.folder, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(group.folder);
    }
  }
}
