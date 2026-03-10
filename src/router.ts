import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Broadcast a message to all JIDs sharing a folder (cross-channel sync).
 * Sends to each connected channel that owns one of the folder's JIDs.
 * The bot message is stored in DB only once (via the first channel) to avoid
 * duplicate messages when the web UI aggregates all JIDs in a folder.
 */
export async function broadcastToFolder(
  channels: Channel[],
  folder: string,
  registeredGroups: Record<string, RegisteredGroup>,
  text: string,
): Promise<void> {
  const targets = Object.entries(registeredGroups)
    .filter(([, g]) => g.folder === folder)
    .map(([jid]) => jid);

  // Pick the first connected JID as the one that stores the message in DB.
  // All other channels send-only to avoid duplicate messages in folder history.
  const storeJid = targets.find((jid) =>
    channels.some((c) => c.ownsJid(jid) && c.isConnected()),
  );

  await Promise.all(
    targets.map(async (jid) => {
      const ch = channels.find((c) => c.ownsJid(jid) && c.isConnected());
      if (!ch) return;
      try {
        await ch.sendMessage(jid, text, { skipStore: jid !== storeJid });
      } catch (err) {
        logger.error(
          { jid, channel: ch.name, err },
          'Failed to send to channel in broadcast',
        );
      }
    }),
  );
}
