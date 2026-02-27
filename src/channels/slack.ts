import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, DEFAULT_SYNC_FOLDER } from '../config.js';
import { loadChannelConfig } from '../channel-config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  NewMessage,
  SendMessageOptions,
} from '../types.js';

const SLACK_JID_SUFFIX = '@slack.nanoclaw';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App | null = null;
  private opts: SlackChannelOpts;
  private connected = false;
  private botUserId: string | null = null;
  private userNameCache = new Map<string, string>();

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const config = loadChannelConfig('slack');
    if (!config.bot_token || !config.app_token) {
      throw new Error(
        'Slack channel requires bot_token and app_token. Configure in Settings.',
      );
    }

    this.app = new App({
      token: config.bot_token,
      appToken: config.app_token,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    // Handle DMs — no trigger required
    this.app.event('message', async ({ event }) => {
      await this.handleMessageEvent(event);
    });

    // Handle @mentions in channels — trigger required
    this.app.event('app_mention', async ({ event }) => {
      await this.handleMentionEvent(event);
    });

    await this.app.start();

    // Fetch bot's own user ID to filter self-messages
    const authResult = await this.app.client.auth.test({
      token: config.bot_token,
    });
    this.botUserId = authResult.user_id as string;

    this.connected = true;
    logger.info(
      { botUserId: this.botUserId },
      'Slack channel connected (Socket Mode)',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(SLACK_JID_SUFFIX);
  }

  async sendMessage(jid: string, text: string, options?: SendMessageOptions): Promise<void> {
    const channelId = jid.replace(SLACK_JID_SUFFIX, '');

    try {
      await this.app!.client.chat.postMessage({
        channel: channelId,
        text,
      });
      logger.info({ channelId, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ channelId, err }, 'Failed to send Slack message');
      throw err;
    }

    if (!options?.skipStore) {
      // Store bot message in DB (following WebChannel pattern)
      const now = new Date().toISOString();
      this.opts.onMessage(jid, {
        id: `slack-bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
    this.connected = false;
    if (this.app) {
      await this.app.stop();
      logger.info('Slack channel disconnected');
    }
  }

  // --- Private helpers ---

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async handleMessageEvent(event: any): Promise<void> {
    // Skip bot messages and subtypes (edits, deletes, joins)
    if (event.bot_id || event.user === this.botUserId) return;
    if (event.subtype) return;
    if (!event.text) return;

    // Only handle DMs (channel_type === 'im')
    if (event.channel_type !== 'im') return;

    const channelId = event.channel as string;
    const jid = `${channelId}${SLACK_JID_SUFFIX}`;
    const now = new Date(parseFloat(event.ts) * 1000).toISOString();

    this.ensureRegistered(jid, channelId, false);
    const senderName = await this.resolveUserName(event.user);

    this.opts.onMessage(jid, {
      id: `slack-${event.ts}`,
      chat_jid: jid,
      sender: event.user,
      sender_name: senderName,
      content: event.text,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private async handleMentionEvent(event: any): Promise<void> {
    if (event.bot_id || event.user === this.botUserId) return;
    if (!event.text) return;

    const channelId = event.channel as string;
    const jid = `${channelId}${SLACK_JID_SUFFIX}`;
    const now = new Date(parseFloat(event.ts) * 1000).toISOString();

    this.ensureRegistered(jid, channelId, true);
    const senderName = await this.resolveUserName(event.user);

    // Replace Slack's <@BOT_ID> mention with @AssistantName for trigger matching
    let content = event.text as string;
    if (this.botUserId) {
      content = content.replace(
        new RegExp(`<@${this.botUserId}>`, 'g'),
        `@${ASSISTANT_NAME}`,
      );
    }

    this.opts.onMessage(jid, {
      id: `slack-${event.ts}`,
      chat_jid: jid,
      sender: event.user,
      sender_name: senderName,
      content,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private ensureRegistered(
    jid: string,
    channelId: string,
    isGroup: boolean,
  ): void {
    const groups = this.opts.registeredGroups();
    if (groups[jid]) return;

    // DMs use the shared sync folder; channels get their own isolated folder
    const folder = isGroup ? `slack-${channelId}` : DEFAULT_SYNC_FOLDER;
    const name = isGroup ? `Slack #${channelId}` : 'Slack DM';

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
      'slack',
      isGroup,
    );
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app!.client.users.info({ user: userId });
      const name =
        result.user?.real_name || result.user?.name || userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return userId;
    }
  }
}
