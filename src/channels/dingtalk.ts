import crypto from 'crypto';

import { DWClient, DWClientDownStream, TOPIC_ROBOT } from 'dingtalk-stream';

import { ASSISTANT_NAME, DEFAULT_SYNC_FOLDER } from '../config.js';
import { loadChannelConfig } from '../channel-config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const DINGTALK_JID_SUFFIX = '@dingtalk.nanoclaw';
const MSG_LIMIT = 20000; // DingTalk text message character limit

export interface DingTalkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

/** DingTalk callback message body (from Stream). */
export interface DingTalkRobotMessage {
  conversationId: string;
  conversationType: string; // '1' = DM, '2' = group
  chatbotUserId?: string;
  msgId?: string;
  msgtype?: string;
  text?: { content: string };
  senderNick?: string;
  senderStaffId?: string;
  senderId?: string;
  createAt?: number;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  conversationTitle?: string;
  robotCode?: string;
}

/**
 * Compute DingTalk HMAC-SHA256 signature for webhook sending.
 * Formula: Base64(HMAC-SHA256(secret, timestamp + "\n" + secret))
 */
export function computeSignature(secret: string, timestamp: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
}

export class DingTalkChannel implements Channel {
  name = 'dingtalk';

  private opts: DingTalkChannelOpts;
  private connected = false;
  private client: DWClient | null = null;
  private webhookUrl = '';
  private webhookSecret = '';
  private clientId = '';
  private clientSecret = '';
  /** Cache sessionWebhook per conversationId for replies. */
  private sessionWebhooks = new Map<string, { url: string; expiresAt: number }>();
  /** Cached OpenAPI access token. */
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(opts: DingTalkChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const config = loadChannelConfig('dingtalk');
    if (!config.client_id || !config.client_secret) {
      throw new Error(
        'DingTalk channel requires Client ID (AppKey) and Client Secret (AppSecret). Configure in Settings.',
      );
    }

    // Store credentials for OpenAPI fallback
    this.clientId = config.client_id;
    this.clientSecret = config.client_secret;

    // Optional: static webhook for proactive messages
    this.webhookUrl = config.webhook_url || '';
    this.webhookSecret = config.secret || '';

    // Ensure DingTalk API calls bypass HTTP proxy (avoids HTTPS→HTTP downgrade)
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    if (!noProxy.includes('dingtalk.com')) {
      process.env.NO_PROXY = noProxy ? `${noProxy},api.dingtalk.com,oapi.dingtalk.com` : 'api.dingtalk.com,oapi.dingtalk.com';
    }

    this.client = new DWClient({
      clientId: config.client_id,
      clientSecret: config.client_secret,
    });

    this.client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
      try {
        const data: DingTalkRobotMessage = JSON.parse(msg.data);
        this.handleRobotMessage(data);
      } catch (err) {
        logger.error({ err }, 'Failed to process DingTalk robot message');
      }
      // Acknowledge to prevent retries
      this.client!.socketCallBackResponse(msg.headers.messageId, { response: '' });
    });

    try {
      await this.client.connect();
    } catch (err: unknown) {
      // Extract DingTalk API response for better error messages
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      const status = axiosErr.response?.status;
      const data = axiosErr.response?.data;
      if (status === 400) {
        const detail = typeof data === 'object' && data ? JSON.stringify(data) : String(data || '');
        throw new Error(
          `DingTalk connection failed (400). Check that Client ID / Client Secret are correct ` +
          `and the app has Stream mode enabled in the DingTalk Developer Portal. ${detail}`,
        );
      }
      throw err;
    }
    this.connected = true;
    logger.info('DingTalk channel connected (Stream mode)');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(DINGTALK_JID_SUFFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const conversationId = jid.replace(DINGTALK_JID_SUFFIX, '');
    const chunks = splitMessage(text, MSG_LIMIT);

    for (const chunk of chunks) {
      await this.send(conversationId, chunk);
    }

    logger.info(
      { conversationId, length: text.length, chunks: chunks.length },
      'DingTalk message sent',
    );

    // Store bot message in DB (following Slack/Web pattern)
    const now = new Date().toISOString();
    this.opts.onMessage(jid, {
      id: `dt-bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: jid,
      sender: 'assistant',
      sender_name: ASSISTANT_NAME,
      content: `${ASSISTANT_NAME}: ${text}`,
      timestamp: now,
      is_from_me: true,
      is_bot_message: true,
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessionWebhooks.clear();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    logger.info('DingTalk channel disconnected');
  }

  // --- Private helpers ---

  private handleRobotMessage(data: DingTalkRobotMessage): void {
    if (!data.conversationId || !data.text?.content) {
      logger.debug({ data }, 'DingTalk message missing required fields, skipping');
      return;
    }

    const conversationId = data.conversationId;
    const jid = `${conversationId}${DINGTALK_JID_SUFFIX}`;
    const isGroup = data.conversationType === '2';

    // Cache sessionWebhook for replies
    if (data.sessionWebhook) {
      this.sessionWebhooks.set(conversationId, {
        url: data.sessionWebhook,
        expiresAt: data.sessionWebhookExpiredTime || (Date.now() + 3600000),
      });
    }

    this.ensureRegistered(jid, conversationId, isGroup, data.conversationTitle);

    const content = data.text.content.trim();
    if (!content) return;

    const now = new Date(data.createAt || Date.now()).toISOString();
    const senderId = data.senderStaffId || data.senderId || 'unknown';
    const senderName = data.senderNick || senderId;

    this.opts.onMessage(jid, {
      id: data.msgId || `dt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: isGroup ? `@${ASSISTANT_NAME} ${content}` : content,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  /** Send message using sessionWebhook (preferred) → static webhook → OpenAPI (fallback). */
  private async send(conversationId: string, text: string): Promise<void> {
    // Try sessionWebhook first (no signing needed, per-conversation)
    const cached = this.sessionWebhooks.get(conversationId);
    if (cached && cached.expiresAt > Date.now()) {
      try {
        await this.postWebhook(cached.url, text, false);
        return;
      } catch (err) {
        logger.warn({ err, conversationId }, 'sessionWebhook failed, trying fallback');
      }
    }

    // Fallback to static webhook
    if (this.webhookUrl) {
      await this.postWebhook(this.webhookUrl, text, true);
      return;
    }

    // Final fallback: OpenAPI with access token
    logger.warn(
      { conversationId },
      'No webhook configured for DingTalk, falling back to OpenAPI',
    );
    await this.sendViaOpenApi(conversationId, text);
  }

  /** Get or refresh an OpenAPI access token using client credentials. */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.token;
    }

    const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`DingTalk accessToken request failed (${resp.status}): ${body}`);
    }

    const result = (await resp.json()) as { accessToken?: string; expireIn?: number };
    if (!result.accessToken) {
      throw new Error('DingTalk accessToken response missing token');
    }

    // Cache with 5-minute safety margin
    this.accessToken = {
      token: result.accessToken,
      expiresAt: Date.now() + ((result.expireIn || 7200) - 300) * 1000,
    };
    return result.accessToken;
  }

  /** Send a message via DingTalk OpenAPI (robot group message). */
  private async sendViaOpenApi(conversationId: string, text: string): Promise<void> {
    const token = await this.getAccessToken();

    const resp = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        robotCode: this.clientId,
        openConversationId: conversationId,
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`DingTalk OpenAPI send failed (${resp.status}): ${body}`);
    }

    const result = (await resp.json()) as { processQueryKey?: string };
    logger.debug({ conversationId, processQueryKey: result.processQueryKey }, 'Sent via DingTalk OpenAPI');
  }

  /** POST a text message to a DingTalk webhook URL. */
  private async postWebhook(baseUrl: string, text: string, sign: boolean): Promise<void> {
    let url = baseUrl;
    if (sign && this.webhookSecret) {
      const timestamp = String(Date.now());
      const sig = computeSignature(this.webhookSecret, timestamp);
      const sep = baseUrl.includes('?') ? '&' : '?';
      url = `${baseUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sig)}`;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`DingTalk webhook failed (${resp.status}): ${body}`);
    }

    const result = (await resp.json()) as { errcode?: number; errmsg?: string };
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`DingTalk API error: ${result.errmsg} (${result.errcode})`);
    }
  }

  private ensureRegistered(
    jid: string,
    conversationId: string,
    isGroup: boolean,
    title?: string,
  ): void {
    const groups = this.opts.registeredGroups();
    if (groups[jid]) return;

    const folder = isGroup ? `dingtalk-${conversationId}` : DEFAULT_SYNC_FOLDER;
    const name = title || (isGroup ? 'DingTalk Group' : 'DingTalk DM');

    this.opts.registerGroup(jid, {
      name,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: isGroup,
    });

    this.opts.onChatMetadata(jid, new Date().toISOString(), name, 'dingtalk', isGroup);
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
