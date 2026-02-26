import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  folder: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  retryCount: number;
}

/**
 * Manages container concurrency and message queuing.
 * Keyed by group folder (not JID) to support cross-channel sync.
 */
export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((folder: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(folder: string): GroupState {
    let state = this.groups.get(folder);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        retryCount: 0,
      };
      this.groups.set(folder, state);
    }
    return state;
  }

  /** Public read-only accessor for container state (used by live-log streaming). */
  getGroupState(folder: string): { active: boolean; containerName: string | null } | null {
    const state = this.groups.get(folder);
    if (!state) return null;
    return { active: state.active, containerName: state.containerName };
  }

  setProcessMessagesFn(fn: (folder: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(folder: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(folder);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ folder }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(folder)) {
        this.waitingGroups.push(folder);
      }
      logger.debug(
        { folder, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(folder, 'messages').catch((err) =>
      logger.error({ folder, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(folder: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(folder);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ folder, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, folder, fn });
      if (state.idleWaiting) {
        this.closeStdin(folder);
      }
      logger.debug({ folder, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, folder, fn });
      if (!this.waitingGroups.includes(folder)) {
        this.waitingGroups.push(folder);
      }
      logger.debug(
        { folder, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(folder, { id: taskId, folder, fn }).catch((err) =>
      logger.error({ folder, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(folder: string, proc: ChildProcess, containerName: string): void {
    const state = this.getGroup(folder);
    state.process = proc;
    state.containerName = containerName;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(folder: string): void {
    const state = this.getGroup(folder);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(folder);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(folder: string, text: string): boolean {
    const state = this.getGroup(folder);
    if (!state.active || state.isTaskContainer) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', folder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(folder: string): void {
    const state = this.getGroup(folder);
    if (!state.active) return;

    const inputDir = path.join(DATA_DIR, 'ipc', folder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    folder: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(folder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { folder, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(folder);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(folder, state);
        }
      }
    } catch (err) {
      logger.error({ folder, err }, 'Error processing messages for group');
      this.scheduleRetry(folder, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(folder);
    }
  }

  private async runTask(folder: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(folder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    this.activeCount++;

    logger.debug(
      { folder, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ folder, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      this.drainGroup(folder);
    }
  }

  private scheduleRetry(folder: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { folder, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { folder, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(folder);
      }
    }, delayMs);
  }

  private drainGroup(folder: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(folder);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(folder, task).catch((err) =>
        logger.error({ folder, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(folder, 'drain').catch((err) =>
        logger.error({ folder, err }, 'Unhandled error in runForGroup (drain)'),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextFolder = this.waitingGroups.shift()!;
      const state = this.getGroup(nextFolder);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextFolder, task).catch((err) =>
          logger.error({ folder: nextFolder, taskId: task.id, err }, 'Unhandled error in runTask (waiting)'),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextFolder, 'drain').catch((err) =>
          logger.error({ folder: nextFolder, err }, 'Unhandled error in runForGroup (waiting)'),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
