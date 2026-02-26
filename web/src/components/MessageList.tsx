import { useEffect, useRef, useState, useCallback } from 'react';
import { Typography, Button, Spin } from 'antd';
import { LoadingOutlined, UserOutlined, RobotOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useT } from '../i18n';
import { CHANNEL_ICONS } from './Icons';
import type { Message } from '../types';
import { getHistory } from '../api';

const { Text } = Typography;
const TRUNCATE_LIMIT = 1500;

interface Props {
  messages: Message[];
  sessionId: string | null;
  jid: string | null;
  olderCount: number;
  isTyping: boolean;
  onOlderLoaded: (msgs: Message[], remaining: number) => void;
}

function renderMarkdown(text: string): string {
  // Strip <attachments> blocks before rendering
  const cleaned = text.replace(/<attachments>[\s\S]*?<\/attachments>/g, '');
  const html = marked.parse(cleaned, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'code', 'pre',
      'ul', 'ol', 'li', 'a', 'img', 'blockquote', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'strong', 'em', 'del', 'details', 'summary', 'span',
      'div', 'iframe', 'embed', 'object', 'video', 'audio', 'source',
      'sub', 'sup', 'mark', 'abbr',
    ],
    ALLOWED_ATTR: [
      'href', 'target', 'rel', 'src', 'alt', 'class', 'style',
      'width', 'height', 'type', 'data', 'controls', 'autoplay',
      'title', 'loading',
    ],
  });
}

function extractFiles(content: string): Array<{ name: string; path: string; type: string }> {
  const files: Array<{ name: string; path: string; type: string }> = [];
  const regex = /<file\s+name="([^"]*)"[^>]*path="([^"]*)"[^>]*type="([^"]*)"[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    files.push({ name: m[1], path: m[2], type: m[3] });
  }
  return files;
}

function FilePreview({ file }: { file: { name: string; path: string; type: string } }) {
  // Rewrite container paths to API paths for web access
  const url = file.path.startsWith('/workspace/group/uploads/')
    ? `/api/files/${file.path.split('/uploads/')[1]}`
    : file.path;

  if (file.type.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img
          className="msg-embed-image"
          src={url}
          alt={file.name}
          loading="lazy"
          style={{ maxWidth: 320, maxHeight: 240, borderRadius: 8, margin: '4px 0' }}
        />
      </a>
    );
  }

  if (file.type === 'application/pdf') {
    return (
      <div className="msg-embed" style={{ margin: '8px 0' }}>
        <embed src={url} type="application/pdf" className="msg-embed-pdf" />
        <div style={{ padding: '4px 8px', fontSize: 12, opacity: 0.7 }}>
          <a href={url} target="_blank" rel="noopener noreferrer">{file.name}</a>
        </div>
      </div>
    );
  }

  if (file.type.startsWith('video/')) {
    return (
      <video controls style={{ maxWidth: '100%', borderRadius: 8, margin: '4px 0' }}>
        <source src={url} type={file.type} />
      </video>
    );
  }

  if (file.type.startsWith('audio/')) {
    return (
      <audio controls style={{ width: '100%', margin: '4px 0' }}>
        <source src={url} type={file.type} />
      </audio>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="bubble-file">
      {file.name}
    </a>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const isUser = !msg.is_bot;
  const files = extractFiles(msg.content);
  const needsTruncation = msg.content.length > TRUNCATE_LIMIT && !isUser;

  const displayContent = needsTruncation && !expanded
    ? msg.content.slice(0, TRUNCATE_LIMIT) + '...'
    : msg.content;

  const timeStr = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const bubbleContent = (
    <>
      {!isUser && msg.channel && msg.channel !== 'web' && (
        <div className="bubble-channel">
          {(() => { const I = CHANNEL_ICONS[msg.channel!]; return I ? <I size={12} /> : null; })()}
          {' '}via {msg.channel}
        </div>
      )}
      <div
        className="msg-markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(displayContent) }}
      />
      {needsTruncation && (
        <Button type="link" size="small" onClick={() => setExpanded(!expanded)} style={{ padding: 0, height: 'auto' }}>
          {expanded ? t('chat.showLess') : t('chat.showMore')}
        </Button>
      )}
      {files.length > 0 && (
        <div className="bubble-files">
          {files.map((f, i) => <FilePreview key={i} file={f} />)}
        </div>
      )}
    </>
  );

  return (
    <div className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-bot'}`}>
      {!isUser && (
        <div className="msg-avatar msg-avatar-bot">
          <RobotOutlined />
        </div>
      )}
      <div className="msg-body">
        <div
          className={`bubble ${isUser ? 'bubble-user' : 'bubble-bot'}`}
          style={{ wordBreak: 'break-word' }}
        >
          {bubbleContent}
        </div>
        {timeStr && <div className={`msg-time ${isUser ? 'msg-time-right' : ''}`}>{timeStr}</div>}
      </div>
      {isUser && (
        <div className="msg-avatar msg-avatar-user">
          {(() => {
            const I = msg.channel && msg.channel !== 'web' ? CHANNEL_ICONS[msg.channel] : null;
            return I ? <I size={16} /> : <UserOutlined />;
          })()}
        </div>
      )}
    </div>
  );
}

export function MessageList({ messages, sessionId, jid, olderCount, isTyping, onOlderLoaded }: Props) {
  const { t } = useT();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const shouldAutoScroll = useRef(true);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isTyping]);

  // Track scroll position to decide auto-scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    shouldAutoScroll.current = atBottom;
  }, []);

  const loadOlder = async () => {
    if (!sessionId || loadingOlder || olderCount <= 0) return;
    setLoadingOlder(true);
    try {
      const earliest = messages[0]?.timestamp;
      const data = await getHistory(sessionId, jid ?? undefined, earliest);
      onOlderLoaded(data.messages, data.olderCount);
    } catch {
      // ignore
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="message-list"
      style={{ flex: 1, overflow: 'auto', padding: '16px 0' }}
    >
      {olderCount > 0 && (
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          <Button type="link" onClick={loadOlder} loading={loadingOlder}>
            {t('chat.loadOlder')}
          </Button>
        </div>
      )}

      {messages.map((msg, i) => (
        <MessageBubble key={`${msg.timestamp}-${i}`} msg={msg} />
      ))}

      {isTyping && (
        <div className="msg-typing-row">
          <Spin indicator={<LoadingOutlined spin />} size="small" />
          <Text type="secondary">{t('chat.thinking', { name: 'AI' })}</Text>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
