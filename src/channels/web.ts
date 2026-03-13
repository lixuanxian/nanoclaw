import crypto from 'crypto';

import { ASSISTANT_NAME, DEFAULT_SYNC_FOLDER } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOptions,
} from '../types.js';

const WEB_JID_SUFFIX = '@web.nanoclaw';

/** Escape special characters for use in XML attribute values. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
}

export interface UploadedFile {
  name: string;
  storedName: string;
  size: number;
  type: string;
  url: string;
}

export class WebChannel implements Channel {
  name = 'web';

  private opts: WebChannelOpts;
  private connections = new Map<string, WebSocketLike>();
  private pendingMessages = new Map<string, string[]>();
  private sessionJids = new Map<string, string>(); // sessionId -> jid
  private sessionModes = new Map<string, 'plan' | 'edit'>();
  private sessionSkills = new Map<string, string[]>();
  private connected = false;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  /** Expose registered groups for upload endpoint to resolve session → group folder. */
  getRegisteredGroups(): Record<string, RegisteredGroup> {
    return this.opts.registeredGroups();
  }

  async connect(): Promise<void> {
    this.connected = true;
    logger.info('Web channel ready');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(WEB_JID_SUFFIX);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const sessionId = jid.replace(WEB_JID_SUFFIX, '');
    const ws = this.connections.get(sessionId);

    const payload = JSON.stringify({ type: 'message', text });

    if (ws && ws.readyState === 1) {
      ws.send(payload);
      logger.debug({ sessionId }, 'Web message sent via WebSocket');
    } else {
      // Queue for when client reconnects
      const queue = this.pendingMessages.get(sessionId) || [];
      queue.push(payload);
      this.pendingMessages.set(sessionId, queue);
      logger.debug(
        { sessionId, queueSize: queue.length },
        'Web message queued (no active WS)',
      );
    }

    if (!options?.skipStore) {
      // Store bot message in DB
      const now = new Date().toISOString();
      this.opts.onMessage(jid, {
        id: `web-bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: jid,
        sender: 'assistant',
        sender_name: ASSISTANT_NAME,
        content: `${ASSISTANT_NAME}: ${text}`,
        timestamp: now,
        is_from_me: true,
        is_bot_message: true,
      });
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sessionId = jid.replace(WEB_JID_SUFFIX, '');
    const ws = this.connections.get(sessionId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'typing', isTyping }));
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const ws of this.connections.values()) {
      ws.close();
    }
    this.connections.clear();
  }

  /**
   * Called by the web server when a WebSocket connects.
   * Registers the session group so folder is known for history aggregation.
   */
  handleConnection(sessionId: string, ws: WebSocketLike): void {
    this.ensureSession(sessionId);
    this.connections.set(sessionId, ws);
    logger.info({ sessionId }, 'Web client connected');

    // Flush pending messages
    const pending = this.pendingMessages.get(sessionId);
    if (pending && pending.length > 0) {
      for (const msg of pending) {
        ws.send(msg);
      }
      this.pendingMessages.delete(sessionId);
      logger.debug(
        { sessionId, count: pending.length },
        'Flushed pending web messages',
      );
    }
  }

  /**
   * Called by the web server when a WebSocket disconnects.
   */
  handleDisconnect(sessionId: string): void {
    this.connections.delete(sessionId);
    logger.debug({ sessionId }, 'Web client disconnected');
  }

  /**
   * Called by the web server when a message arrives from the browser.
   * If files are attached, appends an <attachments> XML block to the content
   * so the container agent can access them at /workspace/group/uploads/.
   */
  getSessionMode(sessionId: string): 'plan' | 'edit' | undefined {
    return this.sessionModes.get(sessionId);
  }

  getSessionSkills(sessionId: string): string[] | undefined {
    return this.sessionSkills.get(sessionId);
  }

  handleMessage(
    sessionId: string,
    text: string,
    files?: UploadedFile[],
    mode?: 'plan' | 'edit',
    skills?: string[],
    targetFolder?: string,
  ): void {
    if (mode) this.sessionModes.set(sessionId, mode);
    if (skills) this.sessionSkills.set(sessionId, skills);

    const jid = this.ensureSession(sessionId, targetFolder);

    let content = text;
    if (files && files.length > 0) {
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      const otherFiles = files.filter((f) => !f.type.startsWith('image/'));

      const parts: string[] = [];

      // Image files: use [Image: ...] marker so agent-runner sends as multimodal content blocks
      for (const f of imageFiles) {
        parts.push(`[Image: uploads/${f.storedName}] ${f.name}`);
      }

      // Non-image files: reference with path so agent can read them
      if (otherFiles.length > 0) {
        const fileLines = otherFiles.map(
          (f) =>
            `- ${f.name} (${f.type}, ${f.size} bytes): /workspace/group/uploads/${f.storedName}`,
        );
        parts.push(
          `[Attached files — use the Read tool to view them]\n${fileLines.join('\n')}`,
        );
      }

      const attachBlock = parts.join('\n');
      content = text ? `${text}\n\n${attachBlock}` : attachBlock;
    }

    const now = new Date().toISOString();
    const msgId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: sessionId,
      sender_name: 'User',
      content,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  /**
   * Ensure a web session is registered as a group.
   * The first web session uses the shared DEFAULT_SYNC_FOLDER for cross-channel sync.
   * Subsequent web sessions ("New Chat") get their own isolated folders.
   * If targetFolder is provided (e.g. when sending from a non-web channel view),
   * the web session joins that folder instead.
   */
  private ensureSession(sessionId: string, targetFolder?: string): string {
    const jid = `${sessionId}${WEB_JID_SUFFIX}`;
    this.sessionJids.set(sessionId, jid);

    // Always check registeredGroups — the session may have been deleted
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      let folder: string;
      if (targetFolder) {
        // Join the same folder as the viewed non-web channel
        folder = targetFolder;
      } else {
        // Use default sync folder unless another web session already has it
        const hasDefaultWeb = Object.entries(groups).some(
          ([j, g]) =>
            j.endsWith(WEB_JID_SUFFIX) && g.folder === DEFAULT_SYNC_FOLDER,
        );
        folder = hasDefaultWeb
          ? `web-${sessionId.slice(0, 8)}`
          : DEFAULT_SYNC_FOLDER;
      }

      // Don't bake AI config into the group — the global AI config
      // fallback chain in index.ts always reads the latest settings.
      this.opts.registerGroup(jid, {
        name: 'Web Chat',
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });

      // Register chat metadata
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        'Web Chat',
        'web',
        false,
      );
    }

    return jid;
  }

  /**
   * Create (or ensure) a session and return its JID.
   * Called from the REST API so the session exists in the DB before the list is refreshed.
   */
  createSession(sessionId: string): string {
    return this.ensureSession(sessionId);
  }

  /**
   * Clear cached session data for a deleted JID so ensureSession re-registers if needed.
   */
  clearSessionCache(jid: string): void {
    const sessionId = jid.replace(WEB_JID_SUFFIX, '');
    this.sessionJids.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.sessionSkills.delete(sessionId);
  }

  /**
   * Generate a new session ID for a fresh browser session.
   */
  static generateSessionId(): string {
    return crypto.randomUUID();
  }
}
