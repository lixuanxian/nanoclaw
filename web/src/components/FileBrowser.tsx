import { useEffect, useState, useMemo } from 'react';
import { Typography, Spin, Table, Button, Modal, Input, Popconfirm, Empty, Breadcrumb, message } from 'antd';
import { FolderOutlined, FileOutlined, FolderAddOutlined, FileAddOutlined, EyeOutlined, EditOutlined, DeleteOutlined, DownloadOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { browseFolder, readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceItem, renameWorkspaceItem, getWorkspaceFileRawUrl, createWorkspaceFile, createWorkspaceFolder } from '../api';
import type { FileEntry } from '../api';
import { useT } from '../i18n';
import { useIsMobile } from '../hooks/useIsMobile';
import { MonacoWrapper, getMonacoLanguage } from './MonacoWrapper';

const { Text } = Typography;

type PreviewType = 'json' | 'markdown' | 'html' | 'pdf' | 'image' | 'audio' | 'video' | 'text';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);

function getPreviewType(fileName: string): PreviewType {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = fileName.slice(dot).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'text';
}

/** True when preview uses the raw binary endpoint instead of text content. */
function isBinaryPreview(type: PreviewType): boolean {
  return type === 'pdf' || type === 'image' || type === 'audio' || type === 'video';
}

/** True when Monaco should be used for preview (syntax-highlighted code). */
function isCodePreview(type: PreviewType): boolean {
  return type === 'json' || type === 'text';
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

interface Props {
  folder: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilePreviewContent({ fileName, content, rawUrl }: { fileName: string; content: string; rawUrl: string }) {
  const type = getPreviewType(fileName);

  const renderedMarkdown = useMemo(() => {
    if (type !== 'markdown') return '';
    const html = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(html);
  }, [type, content]);

  if (type === 'json') {
    return <MonacoWrapper value={formatJson(content)} fileName={fileName} readOnly height={480} />;
  }

  if (type === 'markdown') {
    return (
      <div
        className="markdown-preview"
        style={{ maxHeight: 480, overflow: 'auto', padding: '0 4px', lineHeight: 1.7 }}
        dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
      />
    );
  }

  if (type === 'html') {
    return (
      <iframe
        srcDoc={content}
        sandbox="allow-same-origin"
        style={{ width: '100%', height: 480, border: '1px solid var(--ant-color-border)', borderRadius: 8, background: '#fff' }}
        title={fileName}
      />
    );
  }

  if (type === 'pdf') {
    return (
      <iframe
        src={rawUrl}
        style={{ width: '100%', height: 560, border: '1px solid var(--ant-color-border)', borderRadius: 8 }}
        title={fileName}
      />
    );
  }

  if (type === 'image') {
    return (
      <div style={{ textAlign: 'center', maxHeight: 480, overflow: 'auto' }}>
        <img src={rawUrl} alt={fileName} style={{ maxWidth: '100%', borderRadius: 8 }} />
      </div>
    );
  }

  if (type === 'audio') {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center' }}>
        <audio controls src={rawUrl} style={{ width: '100%' }} />
      </div>
    );
  }

  if (type === 'video') {
    return (
      <div style={{ textAlign: 'center' }}>
        <video controls src={rawUrl} style={{ maxWidth: '100%', maxHeight: 480, borderRadius: 8 }} />
      </div>
    );
  }

  // All other text files — syntax-highlighted via Monaco
  return <MonacoWrapper value={content} fileName={fileName} readOnly height={480} />;
}

/** Markdown editing: split-pane with Monaco editor + live preview. */
function MarkdownEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const renderedHtml = useMemo(() => {
    const html = marked.parse(value, { async: false }) as string;
    return DOMPurify.sanitize(html);
  }, [value]);

  return (
    <div className="markdown-editor-panes" style={{ display: 'flex', gap: 12, height: 'calc(70vh - 100px)', minHeight: 400 }}>
      <div style={{ flex: 1, minWidth: 0, border: '1px solid var(--ant-color-border)', borderRadius: 6, overflow: 'hidden' }}>
        <MonacoWrapper value={value} language="markdown" height="100%" onChange={onChange} />
      </div>
      <div
        className="markdown-preview"
        style={{
          flex: 1, minWidth: 0, overflow: 'auto', padding: '12px 16px', lineHeight: 1.7,
          border: '1px solid var(--ant-color-border)', borderRadius: 6,
          background: 'var(--ant-color-bg-layout)',
        }}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    </div>
  );
}

export function FileBrowser({ folder }: Props) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [subpath, setSubpath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Preview/edit modal
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewEditable, setPreviewEditable] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Rename modal
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  // Create file/folder modal
  const [createType, setCreateType] = useState<'file' | 'folder' | null>(null);
  const [createName, setCreateName] = useState('');

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

  const openPreview = async (fileName: string) => {
    const filePath = subpath ? `${subpath}/${fileName}` : fileName;
    setPreviewFile(fileName);
    setEditing(false);

    const type = getPreviewType(fileName);
    if (isBinaryPreview(type)) {
      setPreviewContent('');
      setPreviewEditable(false);
      setPreviewLoading(false);
      return;
    }

    setPreviewLoading(true);
    try {
      const data = await readWorkspaceFile(folder, filePath);
      setPreviewContent(data.content);
      setPreviewEditable(data.editable);
    } catch {
      setPreviewContent('Failed to load file.');
      setPreviewEditable(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const previewRawUrl = previewFile
    ? getWorkspaceFileRawUrl(folder, subpath ? `${subpath}/${previewFile}` : previewFile)
    : '';

  const handleDownload = (fileName: string) => {
    const filePath = subpath ? `${subpath}/${fileName}` : fileName;
    const url = getWorkspaceFileRawUrl(folder, filePath, true);
    window.open(url, '_blank');
  };

  const handleSave = async () => {
    if (!previewFile) return;
    setSaving(true);
    try {
      const filePath = subpath ? `${subpath}/${previewFile}` : previewFile;
      await writeWorkspaceFile(folder, filePath, editContent);
      setPreviewContent(editContent);
      setEditing(false);
      message.success(t('ws.save'));
    } catch {
      message.error('Save failed');
    } finally {
      setSaving(false);
    }
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

  const breadcrumbParts = subpath ? subpath.split('/') : [];

  // Determine modal width based on context
  const previewType = previewFile ? getPreviewType(previewFile) : 'text';
  const isMarkdownEdit = editing && previewFile && getPreviewType(previewFile) === 'markdown';
  const needsWideModal = editing || isCodePreview(previewType) || ['html', 'markdown', 'pdf', 'video', 'image'].includes(previewType);
  const modalWidth = isMobile
    ? '96vw'
    : isMarkdownEdit ? '92vw' : editing ? '80vw' : needsWideModal ? 800 : 700;

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

      {/* Preview / Edit Modal */}
      <Modal
        title={previewFile || ''}
        open={!!previewFile}
        onCancel={() => setPreviewFile(null)}
        width={modalWidth}
        style={isMarkdownEdit ? { maxWidth: 1400 } : editing ? { maxWidth: 1200 } : undefined}
        destroyOnHidden
        footer={editing ? [
          <Button key="cancel" onClick={() => setEditing(false)}>Cancel</Button>,
          <Button key="save" type="primary" loading={saving} onClick={handleSave}>{t('ws.save')}</Button>,
        ] : [
          ...(previewFile && isBinaryPreview(getPreviewType(previewFile)) ? [
            <Button key="download" icon={<DownloadOutlined />} onClick={() => previewFile && handleDownload(previewFile)}>{t('ws.download')}</Button>,
          ] : []),
          ...(previewEditable ? [
            <Button key="edit" type="primary" onClick={() => { setEditContent(previewContent); setEditing(true); }}>{t('ws.edit')}</Button>,
          ] : []),
        ]}
      >
        {previewLoading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
        ) : editing ? (
          isMarkdownEdit ? (
            <MarkdownEditor value={editContent} onChange={setEditContent} />
          ) : (
            <MonacoWrapper
              value={editContent}
              fileName={previewFile || ''}
              height="calc(70vh - 100px)"
              onChange={setEditContent}
            />
          )
        ) : (
          <FilePreviewContent fileName={previewFile || ''} content={previewContent} rawUrl={previewRawUrl} />
        )}
      </Modal>

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
