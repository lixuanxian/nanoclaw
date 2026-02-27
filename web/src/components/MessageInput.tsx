import { useState, useRef, useCallback, useEffect } from 'react';
import { Input, Button, Upload, Typography, App, Segmented } from 'antd';
import { SendOutlined, PaperClipOutlined, CloseCircleOutlined, EditOutlined } from '@ant-design/icons';
import { uploadFiles } from '../api';
import { useT } from '../i18n';
import { SkillsPicker } from './SkillsPicker';
import type { Message, UploadedFile } from '../types';

const { Text } = Typography;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

interface Props {
  sessionId: string | null;
  onSend: (text: string, files?: UploadedFile[], mode?: 'plan' | 'edit', skills?: string[]) => void;
  disabled?: boolean;
  editingMessage?: Message | null;
  onEditSubmit?: (content: string) => void;
  onCancelEdit?: () => void;
}

export function MessageInput({ sessionId, onSend, disabled, editingMessage, onEditSubmit, onCancelEdit }: Props) {
  const { t } = useT();
  const { message: antMessage } = App.useApp();
  const [text, setText] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState<'plan' | 'edit'>('edit');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const EG_KEYS = ['chat.eg1', 'chat.eg2', 'chat.eg3', 'chat.eg4', 'chat.eg5', 'chat.eg6'];
  const [egIndex, setEgIndex] = useState(() => Math.floor(Math.random() * EG_KEYS.length));
  useEffect(() => {
    const id = setInterval(() => setEgIndex((i) => (i + 1) % EG_KEYS.length), 5000);
    return () => clearInterval(id);
  }, []);
  const placeholder = text ? '' : t(EG_KEYS[egIndex]);

  // Enter edit mode: populate textarea with the message being edited
  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.content);
      inputRef.current?.focus();
    }
  }, [editingMessage]);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const valid: File[] = [];
    for (const f of files) {
      if (f.size > MAX_FILE_SIZE) {
        antMessage.warning(t('chat.fileTooLarge', { name: f.name }));
        continue;
      }
      valid.push(f);
    }
    setPendingFiles((prev) => [...(Array.isArray(prev) ? prev : []), ...valid]);
  }, [t, antMessage]);

  const removeFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;

    // Edit mode: submit the edited content and exit
    if (editingMessage && onEditSubmit) {
      if (!trimmed) return;
      onEditSubmit(trimmed);
      setText('');
      inputRef.current?.focus();
      return;
    }

    if (!sessionId) return;

    let uploaded: UploadedFile[] | undefined;
    if (pendingFiles.length > 0) {
      setUploading(true);
      try {
        uploaded = await uploadFiles(sessionId, pendingFiles);
      } catch (err) {
        antMessage.error(t('chat.uploadFailed', { error: String(err) }));
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    onSend(trimmed, uploaded, mode, selectedSkills.length > 0 ? selectedSkills : undefined);
    setText('');
    setPendingFiles([]);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && editingMessage && onCancelEdit) {
      e.preventDefault();
      onCancelEdit();
      setText('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      addFiles(imageFiles);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  return (
    <div
      className="chat-input-area"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Edit mode banner */}
      {editingMessage && (
        <div className="chat-input-edit-banner">
          <EditOutlined style={{ fontSize: 13 }} />
          <Text style={{ fontSize: 12, flex: 1 }}>{t('chat.editing')}</Text>
          <Button
            type="text"
            size="small"
            icon={<CloseCircleOutlined />}
            onClick={() => { onCancelEdit?.(); setText(''); }}
          />
        </div>
      )}

      {/* File chips above composer */}
      {pendingFiles.length > 0 && (
        <div className="chat-input-files">
          {pendingFiles.map((f, i) => (
            <div key={i} className="chat-input-file-chip">
              {f.type.startsWith('image/') && (
                <img
                  src={URL.createObjectURL(f)}
                  alt={f.name}
                  style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 6 }}
                />
              )}
              <Text ellipsis style={{ maxWidth: 120, fontSize: 12 }}>{f.name}</Text>
              <CloseCircleOutlined
                onClick={() => removeFile(i)}
                style={{ cursor: 'pointer', fontSize: 12, opacity: 0.6 }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Composer box */}
      <div className="chat-input-composer">
        {/* Textarea */}
        <Input.TextArea
          ref={inputRef as unknown as React.Ref<HTMLTextAreaElement>}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          autoSize={{ minRows: 1, maxRows: 6 }}
          disabled={disabled}
          className="chat-input-textarea"
        />

        {/* Bottom toolbar row */}
        <div className="chat-input-toolbar">
          <Upload
            showUploadList={false}
            multiple
            beforeUpload={(file) => {
              addFiles([file]);
              return false;
            }}
          >
            <Button
              icon={<PaperClipOutlined />}
              type="text"
              size="small"
              disabled={disabled}
              className="chat-input-icon-btn"
            />
          </Upload>

          <div className="chat-input-divider" />

          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as 'plan' | 'edit')}
            options={[
              { value: 'edit', label: t('chat.modeEdit') },
              { value: 'plan', label: t('chat.modePlan') },
            ]}
          />

          <SkillsPicker selected={selectedSkills} onChange={setSelectedSkills} />

          <div style={{ flex: 1 }} />

          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            loading={uploading}
            disabled={disabled || (!text.trim() && pendingFiles.length === 0)}
            className="chat-input-send"
          />
        </div>
      </div>
    </div>
  );
}
