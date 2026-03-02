import { useState, useMemo, useEffect } from 'react';
import { Spin, Button, Modal } from 'antd';
import { DownloadOutlined, EditOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useT } from '../i18n';
import { useIsMobile } from '../hooks/useIsMobile';
import { MonacoWrapper } from './MonacoWrapper';

// ---- Shared helpers (re-exported for use elsewhere) ----

export type PreviewType = 'json' | 'markdown' | 'html' | 'pdf' | 'image' | 'audio' | 'video' | 'text';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);

export function getPreviewType(fileName: string): PreviewType {
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

export function isBinaryPreview(type: PreviewType): boolean {
  return type === 'pdf' || type === 'image' || type === 'audio' || type === 'video';
}

export function isCodePreview(type: PreviewType): boolean {
  return type === 'json' || type === 'text';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// ---- Preview content rendering ----

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

  return <MonacoWrapper value={content} fileName={fileName} readOnly height={480} />;
}

// ---- Markdown split-pane editor ----

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

// ---- Main modal component ----

export interface FilePreviewModalProps {
  /** File name to preview, or null to hide the modal. */
  fileName: string | null;
  onClose: () => void;
  /** Read file content. Not called for binary preview types. */
  readFile: (fileName: string) => Promise<{ content: string; editable: boolean; size: number }>;
  /** Write file content. */
  writeFile: (fileName: string, content: string) => Promise<void>;
  /** Get raw file URL for binary previews / downloads. */
  getRawUrl: (fileName: string, download?: boolean) => string;
  /** Called after a successful save. */
  onSaved?: () => void;
}

export function FilePreviewModal({ fileName, onClose, readFile, writeFile, getRawUrl, onSaved }: FilePreviewModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  const [content, setContent] = useState('');
  const [editable, setEditable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Load file content when fileName changes
  useEffect(() => {
    if (!fileName) return;
    setEditing(false);

    const type = getPreviewType(fileName);
    if (isBinaryPreview(type)) {
      setContent('');
      setEditable(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    readFile(fileName)
      .then((data) => { setContent(data.content); setEditable(data.editable); })
      .catch(() => { setContent('Failed to load file.'); setEditable(false); })
      .finally(() => setLoading(false));
  }, [fileName]);

  const handleSave = async () => {
    if (!fileName) return;
    setSaving(true);
    try {
      await writeFile(fileName, editContent);
      setContent(editContent);
      setEditing(false);
      onSaved?.();
    } catch { /* caller handles */ } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setEditing(false);
    onClose();
  };

  const previewType = fileName ? getPreviewType(fileName) : 'text';
  const rawUrl = fileName ? getRawUrl(fileName) : '';
  const isMarkdownEdit = editing && previewType === 'markdown';
  const needsWideModal = editing || isCodePreview(previewType) || ['html', 'markdown', 'pdf', 'video', 'image'].includes(previewType);
  const modalWidth = isMobile
    ? '96vw'
    : isMarkdownEdit ? '92vw' : editing ? '80vw' : needsWideModal ? 800 : 700;

  return (
    <Modal
      title={fileName || ''}
      open={!!fileName}
      onCancel={handleClose}
      width={modalWidth}
      style={isMarkdownEdit ? { maxWidth: 1400 } : editing ? { maxWidth: 1200 } : undefined}
      destroyOnHidden
      footer={editing ? [
        <Button key="cancel" onClick={() => setEditing(false)}>Cancel</Button>,
        <Button key="save" type="primary" loading={saving} onClick={handleSave}>{t('ws.save')}</Button>,
      ] : [
        ...(fileName && isBinaryPreview(previewType) ? [
          <Button key="download" icon={<DownloadOutlined />} onClick={() => fileName && window.open(getRawUrl(fileName, true), '_blank')}>{t('ws.download')}</Button>,
        ] : []),
        ...(editable ? [
          <Button key="edit" type="primary" icon={<EditOutlined />} onClick={() => { setEditContent(content); setEditing(true); }}>{t('ws.edit')}</Button>,
        ] : []),
      ]}
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
      ) : editing ? (
        isMarkdownEdit ? (
          <MarkdownEditor value={editContent} onChange={setEditContent} />
        ) : (
          <MonacoWrapper
            value={editContent}
            fileName={fileName || ''}
            height="calc(70vh - 100px)"
            onChange={setEditContent}
          />
        )
      ) : (
        <FilePreviewContent fileName={fileName || ''} content={content} rawUrl={rawUrl} />
      )}
    </Modal>
  );
}
