import { useEffect, useState } from 'react';
import { Modal, Typography, Spin, Empty, Button, List, Popconfirm, message } from 'antd';
import { ArrowLeftOutlined, FileTextOutlined, DeleteOutlined, ClearOutlined } from '@ant-design/icons';
import { getLogs, getLogContent, deleteLog, cleanupLogs } from '../api';
import type { LogFileInfo } from '../api';
import { useT } from '../i18n';

const { Text } = Typography;

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

export function LogViewer({ folder, open, onClose }: Props) {
  const { t } = useT();
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
    loadLogs();
  }, [open, folder]);

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
      if (selectedLog === filename) {
        setSelectedLog(null);
        setContent('');
      }
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

  const goBack = () => {
    setSelectedLog(null);
    setContent('');
  };

  return (
    <Modal
      title={t('log.title')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={700}
      destroyOnClose
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
      ) : selectedLog ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={goBack}>
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
            <pre style={{
              background: 'var(--ant-color-bg-layout)',
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              maxHeight: 480,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              margin: 0,
            }}>
              {content}
            </pre>
          )}
        </div>
      ) : logs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('log.empty')} />
      ) : (
        <>
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
                <div
                  onClick={() => viewLog(item.name)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}
                >
                  <FileTextOutlined />
                  <div style={{ flex: 1 }}>
                    <Text style={{ display: 'block' }}>
                      {new Date(item.timestamp).toLocaleString()}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('log.size')}: {formatSize(item.size)}
                    </Text>
                  </div>
                </div>
              </List.Item>
            )}
          />
        </>
      )}
    </Modal>
  );
}
