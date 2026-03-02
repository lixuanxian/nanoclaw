import { useEffect, useState, useCallback } from 'react';
import { Typography, Spin, Table, Button, Modal, Input, Popconfirm, Empty, Breadcrumb, message } from 'antd';
import { FolderOutlined, FileOutlined, FolderAddOutlined, FileAddOutlined, EyeOutlined, EditOutlined, DeleteOutlined, DownloadOutlined } from '@ant-design/icons';
import { browseFolder, readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceItem, renameWorkspaceItem, getWorkspaceFileRawUrl, createWorkspaceFile, createWorkspaceFolder } from '../api';
import type { FileEntry } from '../api';
import { useT } from '../i18n';
import { useIsMobile } from '../hooks/useIsMobile';
import { FilePreviewModal, formatSize } from './FilePreviewModal';

const { Text } = Typography;

interface Props {
  folder: string;
}

export function FileBrowser({ folder }: Props) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [subpath, setSubpath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Preview
  const [previewFile, setPreviewFile] = useState<string | null>(null);

  // Rename modal
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  // Create file/folder modal
  const [createType, setCreateType] = useState<'file' | 'folder' | null>(null);
  const [createName, setCreateName] = useState('');

  // Track subpath at the time preview was opened, so callbacks use the correct path
  const [previewSubpath, setPreviewSubpath] = useState('');

  const load = (path: string) => {
    setLoading(true);
    browseFolder(folder, path || undefined)
      .then((data) => { setFiles(data.files); setSubpath(data.path); })
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(''); }, [folder]);

  const navigate = (dirName: string) => {
    const newPath = subpath ? `${subpath}/${dirName}` : dirName;
    load(newPath);
  };

  const navigateBreadcrumb = (index: number) => {
    if (index < 0) { load(''); return; }
    const parts = subpath.split('/');
    load(parts.slice(0, index + 1).join('/'));
  };

  const openPreview = (fileName: string) => {
    setPreviewSubpath(subpath);
    setPreviewFile(fileName);
  };

  const handleDownload = (fileName: string) => {
    const filePath = subpath ? `${subpath}/${fileName}` : fileName;
    const url = getWorkspaceFileRawUrl(folder, filePath, true);
    window.open(url, '_blank');
  };

  const handleDelete = async (name: string) => {
    const filePath = subpath ? `${subpath}/${name}` : name;
    try {
      await deleteWorkspaceItem(folder, filePath);
      load(subpath);
    } catch { /* ignore */ }
  };

  const handleRename = async () => {
    if (!renameTarget || !newName.trim()) return;
    const fromPath = subpath ? `${subpath}/${renameTarget}` : renameTarget;
    const toPath = subpath ? `${subpath}/${newName.trim()}` : newName.trim();
    try {
      await renameWorkspaceItem(folder, fromPath, toPath);
      setRenameTarget(null);
      load(subpath);
    } catch {
      message.error('Rename failed');
    }
  };

  const handleCreate = async () => {
    const name = createName.trim();
    if (!createType || !name) return;
    const itemPath = subpath ? `${subpath}/${name}` : name;
    try {
      if (createType === 'folder') {
        await createWorkspaceFolder(folder, itemPath);
      } else {
        await createWorkspaceFile(folder, itemPath);
      }
      message.success(t('ws.createSuccess'));
      setCreateType(null);
      setCreateName('');
      load(subpath);
    } catch {
      message.error(t('ws.createFailed'));
    }
  };

  // Callbacks for FilePreviewModal — use previewSubpath captured at open time
  const readFile = useCallback(async (fileName: string) => {
    const filePath = previewSubpath ? `${previewSubpath}/${fileName}` : fileName;
    return readWorkspaceFile(folder, filePath);
  }, [folder, previewSubpath]);

  const writeFile = useCallback(async (fileName: string, content: string) => {
    const filePath = previewSubpath ? `${previewSubpath}/${fileName}` : fileName;
    await writeWorkspaceFile(folder, filePath, content);
  }, [folder, previewSubpath]);

  const getRawUrl = useCallback((fileName: string, download?: boolean) => {
    const filePath = previewSubpath ? `${previewSubpath}/${fileName}` : fileName;
    return getWorkspaceFileRawUrl(folder, filePath, download);
  }, [folder, previewSubpath]);

  const breadcrumbParts = subpath ? subpath.split('/') : [];

  const columns = [
    {
      title: t('ws.name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: FileEntry) => (
        <span
          onClick={() => record.type === 'directory' ? navigate(name) : openPreview(name)}
          style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {record.type === 'directory' ? <FolderOutlined /> : <FileOutlined />}
          <span style={{ textDecoration: record.type === 'directory' ? 'none' : 'underline' }}>{name}</span>
        </span>
      ),
    },
    ...(!isMobile ? [
      {
        title: t('ws.size'),
        dataIndex: 'size',
        key: 'size',
        width: 100,
        render: (size: number, record: FileEntry) => record.type === 'directory' ? '—' : formatSize(size),
      },
      {
        title: t('ws.modified'),
        dataIndex: 'modifiedAt',
        key: 'modifiedAt',
        width: 160,
        render: (ts: string) => new Date(ts).toLocaleString(),
      },
    ] : []),
    {
      title: t('ws.actions'),
      key: 'actions',
      width: isMobile ? 100 : 150,
      render: (_: unknown, record: FileEntry) => (
        <div style={{ display: 'flex', gap: 0 }}>
          {record.type === 'file' && (
            <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => openPreview(record.name)} />
          )}
          {record.type === 'file' && (
            <Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(record.name)} />
          )}
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => { setRenameTarget(record.name); setNewName(record.name); }}
          />
          <Popconfirm title={t('ws.deleteConfirm')} onConfirm={() => handleDelete(record.name)}>
            <Button type="text" size="small" icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <Breadcrumb
          items={[
            { title: <span onClick={() => navigateBreadcrumb(-1)} style={{ cursor: 'pointer' }}>{folder}</span> },
            ...breadcrumbParts.map((part, i) => ({
              title: <span onClick={() => navigateBreadcrumb(i)} style={{ cursor: 'pointer' }}>{part}</span>,
            })),
          ]}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" icon={<FileAddOutlined />} onClick={() => { setCreateType('file'); setCreateName(''); }}>
            {!isMobile && t('ws.newFile')}
          </Button>
          <Button size="small" icon={<FolderAddOutlined />} onClick={() => { setCreateType('folder'); setCreateName(''); }}>
            {!isMobile && t('ws.newFolder')}
          </Button>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
      ) : files.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ws.empty')} />
      ) : (
        <Table
          dataSource={files}
          columns={columns}
          rowKey="name"
          pagination={false}
          size="small"
        />
      )}

      <FilePreviewModal
        fileName={previewFile}
        onClose={() => setPreviewFile(null)}
        readFile={readFile}
        writeFile={writeFile}
        getRawUrl={getRawUrl}
        onSaved={() => message.success(t('ws.save'))}
      />

      {/* Rename Modal */}
      <Modal
        title={t('ws.rename')}
        open={!!renameTarget}
        onOk={handleRename}
        onCancel={() => setRenameTarget(null)}
        destroyOnHidden
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{renameTarget}</Text>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('ws.renameTo')}
          onPressEnter={handleRename}
        />
      </Modal>

      {/* Create File/Folder Modal */}
      <Modal
        title={createType === 'folder' ? t('ws.createFolder') : t('ws.createFile')}
        open={!!createType}
        onOk={handleCreate}
        onCancel={() => setCreateType(null)}
        destroyOnHidden
      >
        <Input
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          placeholder={createType === 'folder' ? t('ws.folderName') : t('ws.fileName')}
          onPressEnter={handleCreate}
          autoFocus
        />
      </Modal>
    </div>
  );
}
