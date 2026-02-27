import { useEffect, useRef, useState, useCallback } from 'react';
import { Typography, Button, Spin, Popconfirm } from 'antd';
import { LoadingOutlined, UserOutlined, RobotOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
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
  highlightTimestamp?: string | null;
  searchQuery?: string | null;
  onHighlightDone?: () => void;
  onDeleteMessage?: (msg: Message) => void;
  onEditMessage?: (msg: Message) => void;
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
      'div', 'sub', 'sup', 'mark', 'abbr',
    ],
    ALLOWED_ATTR: [
      'href', 'target', 'rel', 'src', 'alt', 'class',
      'width', 'height', 'title', 'loading',
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

/** Inject <mark> around keyword matches in HTML, only touching text nodes (not tags/attributes). */
function highlightKeywords(html: string, query: string): string {
  const keywords = query.trim().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return html;
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  // Replace only in text segments, skip HTML tags
  return html.replace(/(<[^>]*>)|([^<]+)/g, (_match, tag: string, text: string) => {
    if (tag) return tag;
    return text.replace(pattern, '<mark>$1</mark>');
  });
}

interface BubbleProps {
  msg: Message;
  highlight?: boolean;
  searchQuery?: string;
  onDelete?: (msg: Message) => void;
  onEdit?: (msg: Message) => void;
}

function MessageBubble({ msg, highlight, searchQuery, onDelete, onEdit }: BubbleProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const isUser = !msg.is_bot;
  const files = extractFiles(msg.content);
  const needsTruncation = msg.content.length > TRUNCATE_LIMIT && !isUser;

  const displayContent = needsTruncation && !expanded
    ? msg.content.slice(0, TRUNCATE_LIMIT) + '...'
    : msg.content;

  const timeStr = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const hasActions = !!msg.id && (onDelete || (onEdit && isUser));

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
        dangerouslySetInnerHTML={{ __html: searchQuery ? highlightKeywords(renderMarkdown(displayContent), searchQuery) : renderMarkdown(displayContent) }}
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
    <div
      className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-bot'}${highlight ? ' msg-highlight' : ''}`}
      data-timestamp={msg.timestamp}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!isUser && (
        <div className="msg-avatar msg-avatar-bot">
          <RobotOutlined />
        </div>
      )}
      <div className="msg-body" style={{ position: 'relative' }}>
        <div className={`msg-bubble-wrap ${isUser ? 'msg-bubble-wrap-user' : 'msg-bubble-wrap-bot'}`}>
          <div
            className={`bubble ${isUser ? 'bubble-user' : 'bubble-bot'}`}
            style={{ wordBreak: 'break-word' }}
          >
            {bubbleContent}
          </div>
          {hasActions && (
            <div className={`msg-actions ${hovered ? 'msg-actions-visible' : ''}`}>
              {onEdit && isUser && (
                <button
                  className="msg-action-btn"
                  onClick={(e) => { e.stopPropagation(); onEdit(msg); }}
                  title={t('chat.editMsg') || 'Edit'}
                >
                  <EditOutlined />
                </button>
              )}
              {onDelete && (
                <Popconfirm
                  title={t('chat.deleteMsg')}
                  description={t('chat.deleteMsgConfirm')}
                  onConfirm={() => onDelete(msg)}
                  okText="OK"
                  cancelText="Cancel"
                  placement={isUser ? 'left' : 'right'}
                >
                  <button
                    className="msg-action-btn msg-action-btn-danger"
                    onClick={(e) => e.stopPropagation()}
                    title={t('chat.deleteMsg') || 'Delete'}
                  >
                    <DeleteOutlined />
                  </button>
                </Popconfirm>
              )}
            </div>
          )}
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

export function MessageList({ messages, sessionId, jid, olderCount, isTyping, onOlderLoaded, highlightTimestamp, searchQuery, onHighlightDone, onDeleteMessage, onEditMessage }: Props) {
  const { t } = useT();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const shouldAutoScroll = useRef(true);

  // Auto-scroll to bottom on new messages (skip when highlighting a search result)
  useEffect(() => {
    if (shouldAutoScroll.current && !highlightTimestamp) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isTyping, highlightTimestamp]);

  // Scroll to highlighted message when it appears in the list
  useEffect(() => {
    if (!highlightTimestamp || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-timestamp="${CSS.escape(highlightTimestamp)}"]`) as HTMLElement | null;
    if (el) {
      shouldAutoScroll.current = false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Clear highlight after animation
      const timer = setTimeout(() => onHighlightDone?.(), 2500);
      return () => clearTimeout(timer);
    }
  }, [highlightTimestamp, messages, onHighlightDone]);

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
        <MessageBubble
          key={`${msg.timestamp}-${i}`}
          msg={msg}
          highlight={highlightTimestamp === msg.timestamp}
          searchQuery={highlightTimestamp === msg.timestamp ? searchQuery ?? undefined : undefined}
          onDelete={onDeleteMessage}
          onEdit={onEditMessage}
        />
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
