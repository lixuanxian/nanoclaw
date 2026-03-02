import { useEffect, useState, useCallback } from 'react';
import { Typography, Spin, Button, Empty, Popconfirm, Dropdown, App } from 'antd';
import { FolderOutlined, FileOutlined, DeleteOutlined, LockOutlined, MessageOutlined, EyeOutlined } from '@ant-design/icons';
import { getWorkspaceFolders, cleanupOrphanFolders, readRootFile, getRootFileRawUrl, writeRootFile, deleteRootFile } from '../api';
import type { FolderInfo, FileEntry } from '../api';
import { useT } from '../i18n';
import { CHANNEL_ICONS } from './Icons';
import { FilePreviewModal, formatSize } from './FilePreviewModal';

const { Text } = Typography;

interface Props {
  activeFolder: string | null;
  onSelectFolder: (folder: string) => void;
  onSelectChat: (jid: string, name: string) => void;
}

export function WorkspaceTab({ activeFolder, onSelectFolder, onSelectChat }: Props) {
  const { t } = useT();
  const { message } = App.useApp();
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [rootFiles, setRootFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    getWorkspaceFolders()
      .then((data) => { setFolders(data.folders); setRootFiles(data.rootFiles); })
      .catch(() => { setFolders([]); setRootFiles([]); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const hasOrphans = folders.some((f) => !f.hasConversation && !f.protected);

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      const deleted = await cleanupOrphanFolders();
      message.success(t('ws.cleanupDone', { count: String(deleted.length) }));
      load();
    } catch { /* ignore */ } finally {
      setCleaning(false);
    }
  };

  const handleDeleteRootFile = async (fileName: string) => {
    try {
      await deleteRootFile(fileName);
      load();
    } catch { /* ignore */ }
  };

  // Callbacks for FilePreviewModal
  const readFile = useCallback(async (fileName: string) => readRootFile(fileName), []);
  const writeFile = useCallback(async (fileName: string, content: string) => writeRootFile(fileName, content), []);
  const getRawUrl = useCallback((fileName: string, download?: boolean) => getRootFileRawUrl(fileName, download), []);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>;
  }

  if (folders.length === 0 && rootFiles.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ws.empty')} style={{ marginTop: 48 }} />;
  }

  return (
    <div style={{ padding: '0 8px', height: '100%', overflow: 'auto' }}>
      {hasOrphans && (
        <div style={{ padding: '8px 4px' }}>
          <Popconfirm title={t('ws.cleanupConfirm')} onConfirm={handleCleanup}>
            <Button size="small" danger icon={<DeleteOutlined />} loading={cleaning}>
              {t('ws.cleanupOrphans')}
            </Button>
          </Popconfirm>
        </div>
      )}
      {folders.map((f) => {
        const convs = f.conversations || [];
        const isHovered = hoveredFolder === f.folder;
        const isActive = f.folder === activeFolder;

        let subtitle: string;
        if (f.protected) {
          subtitle = t('ws.reserved');
        } else if (convs.length > 0) {
          subtitle = convs.map((c) => c.name).join(', ');
        } else {
          subtitle = t('ws.orphan');
        }

        let chatAction: React.ReactNode = null;
        if (convs.length === 1) {
          chatAction = (
            <Button
              type="text"
              size="small"
              icon={(() => {
                const Icon = CHANNEL_ICONS[convs[0].channel];
                return Icon ? <Icon size={14} /> : <MessageOutlined />;
              })()}
              style={{ visibility: isHovered ? 'visible' : 'hidden' }}
              onClick={(e) => { e.stopPropagation(); onSelectChat(convs[0].jid, convs[0].name); }}
            />
          );
        } else if (convs.length > 1) {
          chatAction = (
            <Dropdown
              menu={{
                items: convs.map((c) => {
                  const Icon = CHANNEL_ICONS[c.channel];
                  return {
                    key: c.jid,
                    icon: Icon ? <Icon size={14} /> : <MessageOutlined style={{ fontSize: 14 }} />,
                    label: c.name,
                  };
                }),
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  const conv = convs.find((c) => c.jid === key);
                  if (conv) onSelectChat(conv.jid, conv.name);
                },
              }}
              trigger={['click']}
            >
              <Button
                type="text"
                size="small"
                icon={<MessageOutlined />}
                style={{ visibility: isHovered ? 'visible' : 'hidden' }}
                onClick={(e) => e.stopPropagation()}
              />
            </Dropdown>
          );
        }

        return (
          <div
            key={f.folder}
            onClick={() => onSelectFolder(f.folder)}
            onMouseEnter={() => setHoveredFolder(f.folder)}
            onMouseLeave={() => setHoveredFolder(null)}
            style={{
              cursor: 'pointer',
              padding: '10px 12px',
              borderRadius: 8,
              marginBottom: 2,
              background: isActive ? 'var(--ant-color-primary-bg)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              opacity: !f.hasConversation && !f.protected ? 0.55 : 1,
            }}
          >
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <FolderOutlined style={{
                fontSize: 18,
                color: f.protected ? 'var(--ant-color-primary)' : undefined,
              }} />
              {f.protected && (
                <LockOutlined style={{
                  position: 'absolute',
                  fontSize: 8,
                  bottom: -2,
                  right: -4,
                  color: 'var(--ant-color-primary)',
                }} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text ellipsis style={{ display: 'block', fontWeight: isActive ? 500 : 400 }}>
                {f.folder}
              </Text>
              <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                {subtitle}
              </Text>
            </div>
            {chatAction}
          </div>
        );
      })}

      {/* Root-level files */}
      {rootFiles.map((f) => {
        const isHovered = hoveredFolder === `__file__${f.name}`;
        return (
          <div
            key={`__file__${f.name}`}
            onClick={() => setPreviewFile(f.name)}
            onMouseEnter={() => setHoveredFolder(`__file__${f.name}`)}
            onMouseLeave={() => setHoveredFolder(null)}
            style={{
              cursor: 'pointer',
              padding: '10px 12px',
              borderRadius: 8,
              marginBottom: 2,
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <FileOutlined style={{ fontSize: 18 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text ellipsis style={{ display: 'block' }}>
                {f.name}
              </Text>
              <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
                {formatSize(f.size)}
              </Text>
            </div>
            <div style={{ display: 'flex', gap: 0, visibility: isHovered ? 'visible' : 'hidden' }}>
              <Button type="text" size="small" icon={<EyeOutlined />} onClick={(e) => { e.stopPropagation(); setPreviewFile(f.name); }} />
              <Popconfirm title={t('ws.deleteConfirm')} onConfirm={(e) => { e?.stopPropagation(); handleDeleteRootFile(f.name); }}>
                <Button type="text" size="small" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
              </Popconfirm>
            </div>
          </div>
        );
      })}

      <FilePreviewModal
        fileName={previewFile}
        onClose={() => setPreviewFile(null)}
        readFile={readFile}
        writeFile={writeFile}
        getRawUrl={getRawUrl}
        onSaved={() => { message.success(t('ws.save')); load(); }}
      />
    </div>
  );
}
