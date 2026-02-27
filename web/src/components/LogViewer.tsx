import { useEffect, useRef, useState } from 'react';
import { Drawer, Typography, Spin, Empty, Button, List, Popconfirm, Segmented, Badge, message } from 'antd';
import { ArrowLeftOutlined, FileTextOutlined, DeleteOutlined, ClearOutlined } from '@ant-design/icons';
import { getLogs, getLogContent, deleteLog, cleanupLogs } from '../api';
import type { LogFileInfo } from '../api';
import { useLiveLogs } from '../hooks/useLiveLogs';
import { useT } from '../i18n';

const { Text } = Typography;

type Tab = 'live' | 'history';

interface Props {
  folder: string | null;
  open: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const preStyle: React.CSSProperties = {
  background: 'var(--ant-color-bg-layout)',
  padding: 12,
  borderRadius: 8,
  fontSize: 12,
  fontFamily: 'monospace',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  margin: 0,
};

export function LogViewer({ folder, open, onClose }: Props) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('live');

  // --- Live tab state ---
  const { lines, connected, done, clear } = useLiveLogs({ folder, enabled: open && tab === 'live' });
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    if (autoScroll.current && tab === 'live') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines.length, tab]);

  const handleLiveScroll = (e: React.UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget;
    autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  // --- History tab state ---
  const [logs, setLogs] = useState<LogFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);

  const loadLogs = () => {
    if (!folder) return;
    setLoading(true);
    getLogs(folder)
      .then(setLogs)
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open || !folder) return;
    setSelectedLog(null);
    setContent('');
    if (tab === 'history') loadLogs();
  }, [open, folder]);

  useEffect(() => {
    if (tab === 'history' && open && folder) loadLogs();
  }, [tab]);

  const viewLog = async (filename: string) => {
    if (!folder) return;
    setSelectedLog(filename);
    setContentLoading(true);
    try {
      const text = await getLogContent(folder, filename);
      setContent(text);
    } catch {
      setContent('Failed to load log content.');
    } finally {
      setContentLoading(false);
    }
  };

  const handleDeleteLog = async (filename: string) => {
    if (!folder) return;
    try {
      await deleteLog(folder, filename);
      setLogs((prev) => prev.filter((l) => l.name !== filename));
      if (selectedLog === filename) { setSelectedLog(null); setContent(''); }
    } catch { /* ignore */ }
  };

  const handleCleanup = async (keep = 3) => {
    if (!folder) return;
    try {
      const result = await cleanupLogs(folder, keep);
      message.success(t('log.cleanupDone', { count: String(result.deleted.length) }));
      loadLogs();
    } catch { /* ignore */ }
  };

  // --- Live status badge ---
  const statusColor = connected ? '#4ade80' : done ? '#999' : '#f59e0b';
  const statusText = connected
    ? t('livelog.streaming')
    : done ? t('livelog.ended') : t('livelog.connecting');

  // --- Render ---
  const renderLiveTab = () => {
    if (lines.length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={connected ? t('livelog.waiting') : t('livelog.noContainer')}
        />
      );
    }
    return (
      <pre onScroll={handleLiveScroll} style={{ ...preStyle, flex: 1 }}>
        {lines.join('\n')}
        <div ref={bottomRef} />
      </pre>
    );
  };

  const renderHistoryTab = () => {
    if (loading) return <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>;

    if (selectedLog) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button type="text" size="small" icon={<ArrowLeftOutlined />}
              onClick={() => { setSelectedLog(null); setContent(''); }}>
              {t('log.back')}
            </Button>
            <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>{selectedLog}</Text>
            <Popconfirm title={t('log.deleteConfirm')} onConfirm={() => handleDeleteLog(selectedLog)}>
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
          {contentLoading ? (
            <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
          ) : (
            <pre style={{ ...preStyle, flex: 1 }}>{content}</pre>
          )}
        </div>
      );
    }

    if (logs.length === 0) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('log.empty')} />;
    }

    return (
      <div style={{ flex: 1, overflow: 'auto' }}>
        {logs.length > 1 && (
          <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
            <Popconfirm title={t('log.cleanupLatestConfirm')} onConfirm={() => handleCleanup(1)}>
              <Button size="small" icon={<ClearOutlined />}>{t('log.cleanupLatest')}</Button>
            </Popconfirm>
            {logs.length > 3 && (
              <Popconfirm title={t('log.cleanupConfirm')} onConfirm={() => handleCleanup(3)}>
                <Button size="small" icon={<ClearOutlined />}>{t('log.cleanup')}</Button>
              </Popconfirm>
            )}
          </div>
        )}
        <List
          dataSource={logs}
          renderItem={(item) => (
            <List.Item
              style={{ cursor: 'pointer', padding: '8px 12px' }}
              actions={[
                <Popconfirm key="del" title={t('log.deleteConfirm')} onConfirm={() => handleDeleteLog(item.name)}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                </Popconfirm>,
              ]}
            >
              <div onClick={() => viewLog(item.name)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                <FileTextOutlined />
                <div style={{ flex: 1 }}>
                  <Text style={{ display: 'block' }}>{new Date(item.timestamp).toLocaleString()}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('log.size')}: {formatSize(item.size)}</Text>
                </div>
              </div>
            </List.Item>
          )}
        />
      </div>
    );
  };

  const extra = tab === 'live' && lines.length > 0
    ? <Button size="small" icon={<ClearOutlined />} onClick={clear}>{t('livelog.clear')}</Button>
    : undefined;

  return (
    <Drawer
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{t('log.title')}</span>
          {tab === 'live' && (
            <>
              <Badge color={statusColor} />
              <span style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{statusText}</span>
            </>
          )}
        </div>
      }
      placement="bottom"
      size="large"
      open={open}
      onClose={onClose}
      extra={extra}
      destroyOnClose
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
        <Segmented
          size="small"
          value={tab}
          onChange={(val) => setTab(val as Tab)}
          options={[
            { label: t('livelog.title'), value: 'live' },
            { label: t('log.history'), value: 'history' },
          ]}
        />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'live' ? renderLiveTab() : renderHistoryTab()}
        </div>
      </div>
    </Drawer>
  );
}
