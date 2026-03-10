import { useState, useCallback, useRef, useEffect } from 'react';
import { Layout, Typography, Button, Badge } from 'antd';
import { SettingOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useWebSocket, type ConnectionStatus } from '../ws';
import { useT } from '../i18n';
import { getAIConfig, getChannels, createSession, getHistoryAround, markAsRead, deleteMessage, editMessage } from '../api';
import { CHANNEL_ICONS } from '../components/Icons';
import type { ChannelInfo } from '../types';
import { Sidebar } from '../components/Sidebar';
import { MessageList } from '../components/MessageList';
import { MessageInput } from '../components/MessageInput';
import { TaskRunView } from '../components/TaskRunView';
import { FileBrowser } from '../components/FileBrowser';
import { SearchPopover } from '../components/SearchPopover';
import { ThemeToggle } from '../components/ThemeToggle';
import { LanguageToggle } from '../components/LanguageToggle';
import { useIsMobile } from '../hooks/useIsMobile';
import type { Message, ThemeMode, UploadedFile } from '../types';

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

const SUGGESTIONS = [
  'chat.sug1', 'chat.sug2', 'chat.sug3', 'chat.sug4', 'chat.sug5',
];

interface Props {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

function generateSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

const statusColors: Record<ConnectionStatus, string> = {
  connecting: '#f59e0b',
  connected: '#4ade80',
  reconnecting: '#f87171',
};

export function ChatPage({ themeMode, setThemeMode }: Props) {
  const { t, lang, setLang } = useT();
  const navigate = useNavigate();
  const params = useParams<{ jid?: string; taskId?: string; folder?: string }>();
  const location = useLocation();
  const isMobile = useIsMobile();

  const [sessionId, setSessionId] = useState<string>(
    () => localStorage.getItem('nanoclaw_session') || generateSessionId(),
  );
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderCount, setOlderCount] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 768);
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [activeWorkspaceFolder, setActiveWorkspaceFolder] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState('—');
  const [connectedChannels, setConnectedChannels] = useState<ChannelInfo[]>([]);
  const [highlightTimestamp, setHighlightTimestamp] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);

  // Sync URL params → state on mount / URL change
  useEffect(() => {
    if (location.pathname.startsWith('/workspace')) {
      setViewingTaskId(null);
      setActiveWorkspaceFolder(params.folder || null);
    } else if (location.pathname.startsWith('/task')) {
      setActiveWorkspaceFolder(null);
      if (params.taskId) setViewingTaskId(params.taskId);
    } else if (location.pathname.startsWith('/agent-chat')) {
      setViewingTaskId(null);
      setActiveWorkspaceFolder(null);
      if (params.jid) {
        const jid = decodeURIComponent(params.jid);
        const sid = jid.includes('@') ? jid.split('@')[0] : jid;
        setActiveJid(jid);
        localStorage.setItem('nanoclaw_session', sid);
        // Only clear messages when session actually changes —
        // handleSelectSession already clears via updateSession(),
        // and this effect may fire asynchronously after WS delivers history.
        if (sid !== sessionIdRef.current) {
          setSessionId(sid);
          setMessages([]);
          setOlderCount(0);
          setIsTyping(false);
        }
      } else {
        // No JID in URL — derive from current sessionId for list highlighting
        setActiveJid(`${sessionId}@web.nanoclaw`);
      }
    }
  }, [location.pathname, params.jid, params.taskId, params.folder]);

  // Stable refs for WS callbacks to avoid reconnection loops
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const onHistory = useCallback((msgs: Message[], older: number) => {
    setMessages(Array.isArray(msgs) ? msgs : []);
    setOlderCount(older);
  }, []);

  const onMessage = useCallback((msg: Message) => {
    setMessages((prev) => [...(Array.isArray(prev) ? prev : []), msg]);
    setIsTyping(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const onTyping = useCallback((typing: boolean) => {
    setIsTyping(typing);
  }, []);

  const { status, send } = useWebSocket({
    sessionId,
    jid: activeJid,
    onHistory,
    onMessage,
    onTyping,
  });

  useEffect(() => {
    let mounted = true;
    const loadModelInfo = async () => {
      try {
        const data = await getAIConfig();
        const defaultProviderId = data.config?.default_provider;
        if (!defaultProviderId) {
          if (mounted) setModelInfo('—');
          return;
        }

        const provider = data.providers.find((p) => p.id === defaultProviderId);
        const providerConfig = data.config?.providers?.[defaultProviderId];
        const model = providerConfig?.model || provider?.defaultModel || '—';
        const providerName = provider?.name || defaultProviderId;

        if (mounted) setModelInfo(`${providerName}: ${model}`);
      } catch {
        if (mounted) setModelInfo('—');
      }
    };

    loadModelInfo();

    const loadChannels = async () => {
      try {
        const channels = await getChannels();
        if (mounted) {
          setConnectedChannels(channels.filter((ch) => ch.id !== 'web' && ch.status === 'connected'));
        }
      } catch { /* ignore */ }
    };
    loadChannels();

    return () => {
      mounted = false;
    };
  }, []);

  // Persist session
  const updateSession = (id: string) => {
    localStorage.setItem('nanoclaw_session', id);
    setSessionId(id);
    setMessages([]);
    setOlderCount(0);
    setIsTyping(false);
  };

  const handleNewChat = async () => {
    const newId = generateSessionId();
    const jid = `${newId}@web.nanoclaw`;
    updateSession(newId);
    setActiveJid(jid);
    setViewingTaskId(null);
    navigate(`/agent-chat/${encodeURIComponent(jid)}`, { replace: true });
    // Create session on the server first so it exists in the DB before the list refreshes
    await createSession(newId).catch(() => {});
    setRefreshKey((k) => k + 1);
  };

  const handleSelectSession = (jid: string, _name: string, messageTimestamp?: string, query?: string) => {
    // If already viewing this session's chat (not a task/workspace), skip re-selecting
    // to avoid clearing messages without a WebSocket reconnect to re-fetch them
    if (jid === activeJid && !messageTimestamp && !viewingTaskId && !activeWorkspaceFolder) return;

    // Extract session ID from JID (format: sessionId@web.nanoclaw)
    const sid = jid.includes('@') ? jid.split('@')[0] : jid;
    setActiveJid(jid);
    setViewingTaskId(null);
    setHighlightTimestamp(messageTimestamp ?? null);
    setSearchQuery(query ?? null);
    updateSession(sid);
    navigate(`/agent-chat/${encodeURIComponent(jid)}`, { replace: true });
    if (isMobile) setCollapsed(true);

    // Mark conversation as read and refresh sidebar
    markAsRead(jid).then(() => setRefreshKey((k) => k + 1)).catch(() => {});

    // If navigating to a specific message, load messages around its timestamp
    if (messageTimestamp) {
      getHistoryAround(sid, messageTimestamp, jid).then((data) => {
        setMessages(data.messages);
        setOlderCount(data.olderCount);
      }).catch(() => {});
    }
  };

  const handleSelectTask = (taskId: string) => {
    setViewingTaskId(taskId);
    navigate(`/task/${encodeURIComponent(taskId)}`, { replace: true });
    if (isMobile) setCollapsed(true);
  };

  const handleSelectFolder = (folder: string) => {
    setActiveWorkspaceFolder(folder);
    setViewingTaskId(null);
    navigate(`/workspace/${encodeURIComponent(folder)}`, { replace: true });
    if (isMobile) setCollapsed(true);
  };

  const handleSend = (text: string, files?: UploadedFile[], mode?: 'plan' | 'edit', skills?: string[]) => {
    if (!text && !files) return;
    // Add user message to UI immediately
    const userMsg: Message = {
      content: text,
      sender: t('chat.you'),
      timestamp: new Date().toISOString(),
      is_bot: false,
    };
    setMessages((prev) => [...(Array.isArray(prev) ? prev : []), userMsg]);
    send(text, files, mode, skills);
  };

  const handleSuggestion = (key: string) => {
    const text = t(key);
    handleSend(text);
  };

  const handleOlderLoaded = (older: Message[], remaining: number) => {
    const olderArr = Array.isArray(older) ? older : [];
    setMessages((prev) => [...olderArr, ...(Array.isArray(prev) ? prev : [])]);
    setOlderCount(remaining);
  };

  const handleDeleteMessage = async (msg: Message) => {
    if (!msg.id || !activeJid) return;
    try {
      await deleteMessage(msg.id, activeJid);
      setMessages((prev) => prev.filter((m) => m.timestamp !== msg.timestamp || m.content !== msg.content));
      setRefreshKey((k) => k + 1);
    } catch { /* ignore */ }
  };

  const handleEditMessage = (msg: Message) => {
    setEditingMessage(msg);
  };

  const handleEditSubmit = async (newContent: string) => {
    if (!editingMessage?.id || !activeJid) return;
    try {
      await editMessage(editingMessage.id, activeJid, newContent);
      // Remove the edited message and all messages after it from UI
      const editIdx = messages.findIndex((m) => m.timestamp === editingMessage.timestamp && m.content === editingMessage.content);
      if (editIdx !== -1) {
        setMessages((prev) => prev.slice(0, editIdx));
      }
      setEditingMessage(null);
      // Send the new content as a fresh message so AI re-processes
      handleSend(newContent);
    } catch { /* ignore */ }
  };

  const handleCancelEdit = () => {
    setEditingMessage(null);
  };

  return (
    <Layout style={{ height: '100dvh', minHeight: '100vh' }}>
      <Sider
        width={isMobile ? 280 : 320}
        collapsedWidth={0}
        collapsed={collapsed}
        trigger={null}
        style={{
          borderRight: collapsed ? 'none' : '1px solid var(--ant-color-border)',
          overflow: 'hidden',
          padding: collapsed ? '0' : '10px 0px 10px 10px',
        }}
      >
        <Sidebar
          activeJid={activeJid}
          activeTaskId={viewingTaskId}
          activeFolder={activeWorkspaceFolder}
          onSelect={handleSelectSession}
          onNewChat={handleNewChat}
          onSelectTask={handleSelectTask}
          onSelectFolder={handleSelectFolder}
          refreshKey={refreshKey}
        />
      </Sider>

      {isMobile && !collapsed && (
        <div className="sidebar-backdrop" onClick={() => setCollapsed(true)} />
      )}

      <Layout>
        <Header style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 16px 0px 16px',
          height: 48,
          borderBottom: '1px solid var(--ant-color-border)',
          gap: 8,
        }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />

          <Text
            type="secondary"
            className="chat-header-model-info"
            style={{ fontSize: 12, maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {modelInfo}
          </Text>

          <Badge color={statusColors[status]} />
          <Text type="secondary" className="chat-header-status-text" style={{ fontSize: 12 }}>
            {t(`chat.${status}` as 'chat.connecting')}
          </Text>

          <div style={{ flex: 1 }} />

          {connectedChannels.length > 0 && (
            <div className="chat-header-channels" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {connectedChannels.map((ch) => {
                const Icon = CHANNEL_ICONS[ch.id];
                return (
                  <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {Icon && <Icon size={16} />}
                    <Text type="secondary" style={{ fontSize: 12 }}>{ch.name}</Text>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ flex: 1 }} />

          <SearchPopover onNavigate={handleSelectSession} />
          <LanguageToggle lang={lang} setLang={setLang} />
          <ThemeToggle themeMode={themeMode} setThemeMode={setThemeMode} />
          <Button type="text" icon={<SettingOutlined />} onClick={() => navigate('/settings/ai-model')} />
        </Header>

        <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--ant-color-bg-layout)' }}>
          {activeWorkspaceFolder ? (
            <div style={{ flex: 1, overflow: 'auto' }}>
              <FileBrowser folder={activeWorkspaceFolder} />
            </div>
          ) : viewingTaskId ? (
            <TaskRunView taskId={viewingTaskId} onBack={() => { setViewingTaskId(null); navigate('/agent-chat', { replace: true }); }} />
          ) : (
            <>
              {messages.length === 0 && !isTyping ? (
                <div style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  padding: 24,
                  gap: 16,
                }}>
                  <Typography.Title level={4} type="secondary">NanoClaw</Typography.Title>
                  <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    justifyContent: 'center',
                    maxWidth: 600,
                  }}>
                    {SUGGESTIONS.map((key) => (
                      <Button
                        key={key}
                        size="small"
                        onClick={() => handleSuggestion(key)}
                        style={{ maxWidth: 280, whiteSpace: 'normal', height: 'auto', textAlign: 'left', padding: '8px 12px' }}
                      >
                        <Text style={{ fontSize: 12 }}>{t(key)}</Text>
                      </Button>
                    ))}
                  </div>
                </div>
              ) : (
                <MessageList
                  messages={messages}
                  sessionId={sessionId}
                  jid={activeJid}
                  olderCount={olderCount}
                  isTyping={isTyping}
                  onOlderLoaded={handleOlderLoaded}
                  highlightTimestamp={highlightTimestamp}
                  searchQuery={searchQuery}
                  onHighlightDone={() => { setHighlightTimestamp(null); setSearchQuery(null); }}
                  onDeleteMessage={handleDeleteMessage}
                  onEditMessage={handleEditMessage}
                />
              )}

              <MessageInput
                sessionId={sessionId}
                onSend={handleSend}
                disabled={status !== 'connected'}
                editingMessage={editingMessage}
                onEditSubmit={handleEditSubmit}
                onCancelEdit={handleCancelEdit}
              />
            </>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
