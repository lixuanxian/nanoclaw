import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DEFAULT_SYNC_FOLDER, STORE_DIR } from '../config.js';
import { loadChannelConfig } from '../channel-config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  SendMessageOptions,
} from '../types.js';

const QQ_JID_SUFFIX = '@qq.nanoclaw';
const MSG_LIMIT = 2000; // QQ text message character limit
const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const SESSION_PATH = path.join(STORE_DIR, 'qq-session.json');

// Reconnection backoff delays (ms)
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];

// Intent bitmask
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
const INTENT_DIRECT_MESSAGE = 1 << 12;
const INTENT_GROUP_AND_C2C = 1 << 25;
const INTENTS =
  INTENT_PUBLIC_GUILD_MESSAGES | INTENT_DIRECT_MESSAGE | INTENT_GROUP_AND_C2C;

// WebSocket opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Conversation type for routing outbound messages. */
type ConvType = 'group' | 'c2c' | 'guild' | 'guild_dm';

/** Persisted per-conversation metadata. */
interface ConversationMeta {
  type: ConvType;
  /** group_openid, user_openid, channel_id, or guild_id */
  openid: string;
  /** For guild DMs we also need the guild_id to construct the DM endpoint. */
  guildId?: string;
}

/** Cached last inbound msg_id for passive reply. */
interface LastMsg {
  msgId: string;
  timestamp: number;
}

/** Persisted WebSocket session for RESUME. */
interface SessionData {
  sessionId: string;
  sequence: number;
  resumeGatewayUrl: string;
}

export interface QQChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export class QQChannel implements Channel {
  name = 'qq';

  private opts: QQChannelOpts;
  private connected = false;
  private appId = '';
  private clientSecret = '';

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAcked = true;
  private reconnectAttempt = 0;
  private intentionalClose = false;

  /** WebSocket session for RESUME. */
  private session: SessionData | null = null;
  private sequence = 0;

  /** Cached OAuth2 access token. */
  private accessToken: { token: string; expiresAt: number } | null = null;

  /** Per-conversation metadata. Persisted to disk. */
  private conversations = new Map<string, ConversationMeta>();

  /** Last inbound msg_id per JID for passive reply. */
  private lastMsgIds = new Map<string, LastMsg>();

  /** Per-openid message sequence counter for proactive sends. */
  private msgSeqCounters = new Map<string, number>();

  constructor(opts: QQChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const config = loadChannelConfig('qq');
    if (!config.app_id || !config.client_secret) {
      throw new Error(
        'QQ channel requires App ID and Client Secret. Configure in Settings.',
      );
    }

    this.appId = config.app_id;
    this.clientSecret = config.client_secret;

    // Load persisted session and conversation metadata
    this.loadSession();

    // Ensure QQ API calls bypass HTTP proxy
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    if (!noProxy.includes('qq.com')) {
      process.env.NO_PROXY = noProxy
        ? `${noProxy},api.sgroup.qq.com,bots.qq.com`
        : 'api.sgroup.qq.com,bots.qq.com';
    }

    // Get access token and gateway URL, then connect WebSocket
    const token = await this.getAccessToken();
    const gatewayUrl = await this.fetchGatewayUrl(token);
    await this.connectWebSocket(
      this.session?.resumeGatewayUrl || gatewayUrl,
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(QQ_JID_SUFFIX);
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const openid = jid.replace(QQ_JID_SUFFIX, '');
    const chunks = splitMessage(text, MSG_LIMIT);
    const meta = this.conversations.get(openid);
    const convType: ConvType = meta?.type ?? 'group';

    for (const chunk of chunks) {
      const lastMsg = this.lastMsgIds.get(jid);
      // Passive reply: use msg_id if within 5 minutes
      const usePassive =
        lastMsg && Date.now() - lastMsg.timestamp < 300_000;

      if (convType === 'group') {
        await this.sendWithFallback(
          () =>
            this.postGroupMessage(
              openid,
              chunk,
              usePassive ? lastMsg!.msgId : undefined,
              usePassive ? undefined : this.nextMsgSeq(openid),
            ),
          // Fallback: try the other mode
          lastMsg
            ? () =>
                this.postGroupMessage(
                  openid,
                  chunk,
                  usePassive ? undefined : lastMsg.msgId,
                  usePassive ? this.nextMsgSeq(openid) : undefined,
                )
            : undefined,
        );
      } else if (convType === 'c2c') {
        await this.sendWithFallback(
          () =>
            this.postC2CMessage(
              openid,
              chunk,
              usePassive ? lastMsg!.msgId : undefined,
              usePassive ? undefined : this.nextMsgSeq(openid),
            ),
          lastMsg
            ? () =>
                this.postC2CMessage(
                  openid,
                  chunk,
                  usePassive ? undefined : lastMsg.msgId,
                  usePassive ? this.nextMsgSeq(openid) : undefined,
                )
            : undefined,
        );
      } else if (convType === 'guild') {
        await this.postGuildMessage(
          openid,
          chunk,
          usePassive ? lastMsg!.msgId : undefined,
        );
      } else if (convType === 'guild_dm') {
        const guildId = meta?.guildId || openid;
        await this.postGuildDM(
          guildId,
          chunk,
          usePassive ? lastMsg!.msgId : undefined,
        );
      }
    }

    logger.info(
      { openid, length: text.length, chunks: chunks.length, convType },
      'QQ message sent',
    );

    if (!options?.skipStore) {
      const now = new Date().toISOString();
      this.opts.onMessage(jid, {
        id: `qq-bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.connected = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('QQ channel disconnected');
  }

  // --- WebSocket Gateway ---

  private async fetchGatewayUrl(token: string): Promise<string> {
    const resp = await fetch(`${API_BASE}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `QQ gateway URL request failed (${resp.status}): ${body}`,
      );
    }
    const data = (await resp.json()) as { url?: string };
    if (!data.url) {
      throw new Error('QQ gateway response missing URL');
    }
    return data.url;
  }

  private connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      this.intentionalClose = false;

      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        logger.debug('QQ WebSocket opened');
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as {
            op: number;
            d: unknown;
            s: number;
            t: string;
          };
          this.handlePayload(payload);

          // Resolve on READY or RESUMED
          if (
            !resolved &&
            payload.op === OP_DISPATCH &&
            (payload.t === 'READY' || payload.t === 'RESUMED')
          ) {
            resolved = true;
            resolve();
          }
        } catch (err) {
          logger.error({ err }, 'Failed to parse QQ WebSocket message');
        }
      };

      ws.onclose = (event) => {
        this.connected = false;
        this.stopHeartbeat();
        logger.warn(
          { code: event.code, reason: event.reason },
          'QQ WebSocket closed',
        );

        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `QQ WebSocket closed before ready (code ${event.code})`,
            ),
          );
          return;
        }

        // Do not reconnect on fatal codes or intentional close
        if (this.intentionalClose) return;
        if (event.code === 4914 || event.code === 4915) {
          logger.error(
            { code: event.code },
            'QQ bot is offline or banned, not reconnecting',
          );
          return;
        }

        // Clear session on invalid session close codes
        if (event.code === 4006 || event.code === 4009) {
          this.session = null;
        }

        this.scheduleReconnect();
      };

      ws.onerror = (event) => {
        logger.error({ event }, 'QQ WebSocket error');
      };
    });
  }

  private handlePayload(payload: {
    op: number;
    d: unknown;
    s: number;
    t: string;
  }): void {
    // Update sequence number for DISPATCH events
    if (payload.s) {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case OP_HELLO: {
        const d = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(d.heartbeat_interval);

        // Send IDENTIFY or RESUME
        if (this.session?.sessionId) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }

      case OP_DISPATCH:
        this.handleDispatch(payload.t, payload.d);
        break;

      case OP_HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;

      case OP_RECONNECT:
        logger.info('QQ server requested reconnect');
        this.ws?.close();
        break;

      case OP_INVALID_SESSION: {
        const canResume = payload.d as boolean;
        if (!canResume) {
          logger.warn('QQ session invalid, re-identifying');
          this.session = null;
        }
        // Wait a bit then identify/resume
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            if (canResume && this.session?.sessionId) {
              this.sendResume();
            } else {
              this.sendIdentify();
            }
          }
        }, 1000 + Math.random() * 4000);
        break;
      }
    }
  }

  private handleDispatch(eventType: string, data: unknown): void {
    switch (eventType) {
      case 'READY': {
        const d = data as {
          session_id: string;
          user: { id: string; username: string };
        };
        this.session = {
          sessionId: d.session_id,
          sequence: this.sequence,
          resumeGatewayUrl: this.session?.resumeGatewayUrl || '',
        };
        this.connected = true;
        this.reconnectAttempt = 0;
        this.saveSession();
        logger.info(
          { sessionId: d.session_id, bot: d.user?.username },
          'QQ channel connected',
        );
        break;
      }

      case 'RESUMED':
        this.connected = true;
        this.reconnectAttempt = 0;
        logger.info('QQ session resumed');
        break;

      case 'GROUP_AT_MESSAGE_CREATE':
        this.handleGroupMessage(
          data as {
            id: string;
            group_openid: string;
            content: string;
            author: { member_openid: string };
            timestamp: string;
          },
        );
        break;

      case 'C2C_MESSAGE_CREATE':
        this.handleC2CMessage(
          data as {
            id: string;
            author: { user_openid: string };
            content: string;
            timestamp: string;
          },
        );
        break;

      case 'AT_MESSAGE_CREATE':
        this.handleGuildMessage(
          data as {
            id: string;
            channel_id: string;
            guild_id: string;
            content: string;
            author: { id: string; username: string };
            timestamp: string;
          },
        );
        break;

      case 'DIRECT_MESSAGE_CREATE':
        this.handleGuildDM(
          data as {
            id: string;
            guild_id: string;
            channel_id: string;
            content: string;
            author: { id: string; username: string };
            timestamp: string;
          },
        );
        break;
    }
  }

  // --- Heartbeat ---

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        logger.warn('QQ heartbeat not ACKed, reconnecting');
        this.ws?.close();
        return;
      }
      this.heartbeatAcked = false;
      this.wsSend({ op: OP_HEARTBEAT, d: this.sequence });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- IDENTIFY / RESUME ---

  private async sendIdentify(): Promise<void> {
    const token = await this.getAccessToken();
    this.wsSend({
      op: OP_IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: INTENTS,
        shard: [0, 1],
      },
    });
  }

  private async sendResume(): Promise<void> {
    const token = await this.getAccessToken();
    this.wsSend({
      op: OP_RESUME,
      d: {
        token: `QQBot ${token}`,
        session_id: this.session!.sessionId,
        seq: this.sequence,
      },
    });
  }

  private wsSend(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // --- Reconnection ---

  private scheduleReconnect(): void {
    const delay =
      RECONNECT_DELAYS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ];
    this.reconnectAttempt++;
    logger.info(
      { attempt: this.reconnectAttempt, delayMs: delay },
      'QQ scheduling reconnect',
    );

    setTimeout(async () => {
      try {
        const token = await this.getAccessToken();
        const gatewayUrl = await this.fetchGatewayUrl(token);
        await this.connectWebSocket(
          this.session?.resumeGatewayUrl || gatewayUrl,
        );
      } catch (err) {
        logger.error({ err }, 'QQ reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  // --- OAuth2 Token ---

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.token;
    }

    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `QQ accessToken request failed (${resp.status}): ${body}`,
      );
    }

    const result = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!result.access_token) {
      throw new Error('QQ accessToken response missing token');
    }

    // Cache with 5-minute safety margin
    this.accessToken = {
      token: result.access_token,
      expiresAt: Date.now() + ((result.expires_in || 7200) - 300) * 1000,
    };
    return result.access_token;
  }

  // --- Inbound Message Handlers ---

  private handleGroupMessage(data: {
    id: string;
    group_openid: string;
    content: string;
    author: { member_openid: string };
    timestamp: string;
  }): void {
    const groupOpenid = data.group_openid;
    const jid = `${groupOpenid}${QQ_JID_SUFFIX}`;
    const senderId = data.author.member_openid;

    this.conversations.set(groupOpenid, { type: 'group', openid: groupOpenid });
    this.saveSession();

    this.ensureRegistered(jid, groupOpenid, 'group');
    this.lastMsgIds.set(jid, { msgId: data.id, timestamp: Date.now() });

    const content = (data.content || '').trim();
    if (!content) return;

    this.opts.onMessage(jid, {
      id: data.id || `qq-${Date.now()}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderId,
      content: `@${ASSISTANT_NAME} ${content}`,
      timestamp: data.timestamp || new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private handleC2CMessage(data: {
    id: string;
    author: { user_openid: string };
    content: string;
    timestamp: string;
  }): void {
    const userOpenid = data.author.user_openid;
    const jid = `${userOpenid}${QQ_JID_SUFFIX}`;

    this.conversations.set(userOpenid, { type: 'c2c', openid: userOpenid });
    this.saveSession();

    this.ensureRegistered(jid, userOpenid, 'c2c');
    this.lastMsgIds.set(jid, { msgId: data.id, timestamp: Date.now() });

    const content = (data.content || '').trim();
    if (!content) return;

    this.opts.onMessage(jid, {
      id: data.id || `qq-${Date.now()}`,
      chat_jid: jid,
      sender: userOpenid,
      sender_name: userOpenid,
      content,
      timestamp: data.timestamp || new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private handleGuildMessage(data: {
    id: string;
    channel_id: string;
    guild_id: string;
    content: string;
    author: { id: string; username: string };
    timestamp: string;
  }): void {
    const channelId = data.channel_id;
    const jid = `${channelId}${QQ_JID_SUFFIX}`;
    const senderId = data.author.id;
    const senderName = data.author.username || senderId;

    this.conversations.set(channelId, {
      type: 'guild',
      openid: channelId,
      guildId: data.guild_id,
    });
    this.saveSession();

    this.ensureRegistered(jid, channelId, 'guild');
    this.lastMsgIds.set(jid, { msgId: data.id, timestamp: Date.now() });

    const content = (data.content || '').trim();
    if (!content) return;

    this.opts.onMessage(jid, {
      id: data.id || `qq-${Date.now()}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: `@${ASSISTANT_NAME} ${content}`,
      timestamp: data.timestamp || new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private handleGuildDM(data: {
    id: string;
    guild_id: string;
    channel_id: string;
    content: string;
    author: { id: string; username: string };
    timestamp: string;
  }): void {
    const guildId = data.guild_id;
    const jid = `${guildId}${QQ_JID_SUFFIX}`;
    const senderId = data.author.id;
    const senderName = data.author.username || senderId;

    this.conversations.set(guildId, {
      type: 'guild_dm',
      openid: guildId,
      guildId,
    });
    this.saveSession();

    this.ensureRegistered(jid, guildId, 'guild_dm');
    this.lastMsgIds.set(jid, { msgId: data.id, timestamp: Date.now() });

    const content = (data.content || '').trim();
    if (!content) return;

    this.opts.onMessage(jid, {
      id: data.id || `qq-${Date.now()}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp: data.timestamp || new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  }

  /** Try primary send; on failure, attempt fallback (opposite passive/proactive mode). */
  private async sendWithFallback(
    primary: () => Promise<void>,
    fallback?: () => Promise<void>,
  ): Promise<void> {
    try {
      await primary();
    } catch (err) {
      if (!fallback) throw err;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'QQ primary send failed, trying fallback mode',
      );
      await fallback();
    }
  }

  // --- Outbound Message Helpers ---

  /** Post to QQ API and validate the response (checks both HTTP status and body error code). */
  private async qqPost(
    url: string,
    body: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    const token = await this.getAccessToken();
    logger.debug({ url, body, label }, 'QQ API request');

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
    });

    const respText = await resp.text().catch(() => '');
    let respJson: { code?: number; message?: string; trace_id?: string } = {};
    try {
      respJson = JSON.parse(respText);
    } catch {
      // not JSON
    }

    if (!resp.ok) {
      logger.error(
        { status: resp.status, body: respText, label },
        'QQ API HTTP error',
      );
      throw new Error(
        `${label} failed (${resp.status}): ${respJson.message || respText}`,
      );
    }

    // QQ API can return 200 with error code in body
    if (respJson.code && respJson.code !== 0) {
      logger.error(
        { code: respJson.code, message: respJson.message, trace_id: respJson.trace_id, label },
        'QQ API returned error code',
      );
      throw new Error(
        `${label} failed (code ${respJson.code}): ${respJson.message || respText}`,
      );
    }

    logger.debug({ label, trace_id: respJson.trace_id }, 'QQ API success');
  }

  private async postGroupMessage(
    groupOpenid: string,
    content: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { content, msg_type: 0 };
    if (msgId) body.msg_id = msgId;
    if (msgSeq !== undefined) body.msg_seq = msgSeq;
    await this.qqPost(
      `${API_BASE}/v2/groups/${groupOpenid}/messages`,
      body,
      `QQ group send (openid=${groupOpenid}, passive=${!!msgId})`,
    );
  }

  private async postC2CMessage(
    userOpenid: string,
    content: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { content, msg_type: 0 };
    if (msgId) body.msg_id = msgId;
    if (msgSeq !== undefined) body.msg_seq = msgSeq;
    await this.qqPost(
      `${API_BASE}/v2/users/${userOpenid}/messages`,
      body,
      `QQ C2C send (openid=${userOpenid}, passive=${!!msgId})`,
    );
  }

  private async postGuildMessage(
    channelId: string,
    content: string,
    msgId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { content };
    if (msgId) body.msg_id = msgId;
    await this.qqPost(
      `${API_BASE}/channels/${channelId}/messages`,
      body,
      `QQ guild send (channel=${channelId}, passive=${!!msgId})`,
    );
  }

  private async postGuildDM(
    guildId: string,
    content: string,
    msgId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { content };
    if (msgId) body.msg_id = msgId;
    await this.qqPost(
      `${API_BASE}/dms/${guildId}/messages`,
      body,
      `QQ guild DM send (guild=${guildId}, passive=${!!msgId})`,
    );
  }

  // --- Group Registration ---

  private ensureRegistered(
    jid: string,
    openid: string,
    type: ConvType,
  ): void {
    const groups = this.opts.registeredGroups();
    if (groups[jid]) return;

    const isGroup = type === 'group' || type === 'guild';
    const folder = isGroup ? `qq-${openid}` : DEFAULT_SYNC_FOLDER;
    const name =
      type === 'group'
        ? 'QQ Group'
        : type === 'c2c'
          ? 'QQ DM'
          : type === 'guild'
            ? 'QQ Guild Channel'
            : 'QQ Guild DM';

    this.opts.registerGroup(jid, {
      name,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: isGroup,
    });

    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      name,
      'qq',
      isGroup,
    );
  }

  // --- Session Persistence ---

  private loadSession(): void {
    try {
      if (fs.existsSync(SESSION_PATH)) {
        const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
        if (raw && typeof raw === 'object') {
          if (raw.sessionId) {
            this.session = {
              sessionId: raw.sessionId,
              sequence: raw.sequence || 0,
              resumeGatewayUrl: raw.resumeGatewayUrl || '',
            };
            this.sequence = raw.sequence || 0;
          }
          if (raw.conversations && typeof raw.conversations === 'object') {
            for (const [id, meta] of Object.entries(raw.conversations)) {
              this.conversations.set(id, meta as ConversationMeta);
            }
          }
          if (raw.msgSeqCounters && typeof raw.msgSeqCounters === 'object') {
            for (const [id, seq] of Object.entries(raw.msgSeqCounters)) {
              this.msgSeqCounters.set(id, seq as number);
            }
          }
          logger.debug(
            { conversations: this.conversations.size, hasSession: !!this.session },
            'Loaded persisted QQ session',
          );
        }
      }
    } catch {
      logger.warn('Failed to load QQ session, starting fresh');
    }
  }

  private saveSession(): void {
    try {
      const obj: Record<string, unknown> = {};
      if (this.session) {
        obj.sessionId = this.session.sessionId;
        obj.sequence = this.sequence;
        obj.resumeGatewayUrl = this.session.resumeGatewayUrl;
      }
      const convs: Record<string, ConversationMeta> = {};
      for (const [id, meta] of this.conversations) {
        convs[id] = meta;
      }
      obj.conversations = convs;

      const seqs: Record<string, number> = {};
      for (const [id, seq] of this.msgSeqCounters) {
        seqs[id] = seq;
      }
      obj.msgSeqCounters = seqs;

      fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
      fs.writeFileSync(SESSION_PATH, JSON.stringify(obj, null, 2) + '\n');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist QQ session');
    }
  }

  // --- Utilities ---

  private nextMsgSeq(openid: string): number {
    const current = this.msgSeqCounters.get(openid) || 0;
    const next = current + 1;
    this.msgSeqCounters.set(openid, next);
    this.saveSession();
    return next;
  }
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }
  return chunks;
}
