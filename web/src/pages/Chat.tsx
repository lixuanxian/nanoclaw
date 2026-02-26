import { useState, useCallback, useRef, useEffect } from 'react';
import { Layout, Typography, Button, Badge } from 'antd';
import { SettingOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useWebSocket, type ConnectionStatus } from '../ws';
import { useT } from '../i18n';
import { getAIConfig, getChannels, createSession, getHistoryAround } from '../api';
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
  return crypto.randomUUID();
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

  const [sessionId, setSessionId] = useState<string>(
    () => localStorage.getItem('nanoclaw_session') || generateSessionId(),
  );
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderCount, setOlderCount] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [activeWorkspaceFolder, setActiveWorkspaceFolder] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState('—');
  const [connectedChannels, setConnectedChannels] = useState<ChannelInfo[]>([]);
  const [highlightTimestamp, setHighlightTimestamp] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);

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
        setSessionId(sid);
        setMessages([]);
        setOlderCount(0);
        setIsTyping(false);
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
    // Extract session ID from JID (format: sessionId@web.nanoclaw)
    const sid = jid.includes('@') ? jid.split('@')[0] : jid;
    setActiveJid(jid);
    setViewingTaskId(null);
    setHighlightTimestamp(messageTimestamp ?? null);
    setSearchQuery(query ?? null);
    updateSession(sid);
    navigate(`/agent-chat/${encodeURIComponent(jid)}`, { replace: true });

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
  };

  const handleSelectFolder = (folder: string) => {
    setActiveWorkspaceFolder(folder);
    setViewingTaskId(null);
    navigate(`/workspace/${encodeURIComponent(folder)}`, { replace: true });
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

  return (
    <Layout style={{  height: 'calc(100vh)' }}>
      <Sider
        width={320}
        collapsedWidth={0}
        collapsed={collapsed}
        trigger={null}
        style={{
          borderRight: '1px solid var(--ant-color-border)',
          overflow: 'hidden',
          padding: '10px 0px 10px 10px',
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
            style={{ fontSize: 12, maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {modelInfo}
          </Text>

          <Badge color={statusColors[status]} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t(`chat.${status}` as 'chat.connecting')}
          </Text>

          <div style={{ flex: 1 }} />

          {connectedChannels.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
                />
              )}

              <MessageInput
                sessionId={sessionId}
                onSend={handleSend}
                disabled={status !== 'connected'}
              />
            </>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
