import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
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

  await Promise.all(
    targets.map(async (jid) => {
      const ch = channels.find((c) => c.ownsJid(jid) && c.isConnected());
      if (!ch) return;
      try {
        await ch.sendMessage(jid, text);
      } catch (err) {
        logger.error({ jid, channel: ch.name, err }, 'Failed to send to channel in broadcast');
      }
    }),
  );
}
