import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Typography, Spin, Modal, Input, Switch, Form, Select, Dropdown, Checkbox, App } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, DownloadOutlined, MessageOutlined, FolderOutlined, ExclamationCircleOutlined, FileTextOutlined, EllipsisOutlined } from '@ant-design/icons';
import { getConversations, deleteConversation, getDeleteInfo, getGroups, updateGroup, getAIConfig, getExportUrl } from '../api';
import type { DeleteInfo } from '../types';
import { useT } from '../i18n';
import { CHANNEL_ICONS } from './Icons';
import { LogViewer } from './LogViewer';
import type { RegisteredGroupInfo, ProviderInfo } from '../types';

const { Text } = Typography;

interface MergedAgent {
  jid: string;
  name: string;
  channel: string;
  preview: string | null;
  lastMessageTime: string | null;
  folder: string | null;
  trigger: string | null;
  requiresTrigger: boolean;
  added_at: string | null;
  containerConfig: { provider?: string; model?: string } | null;
  unreadCount: number;
}

interface Props {
  activeJid: string | null;
  onSelect: (jid: string, name: string) => void;
  onNewChat: () => void;
  onSelectFolder: (folder: string) => void;
  refreshKey: number;
  onUnreadChange?: (total: number) => void;
}

export function AgentList({ activeJid, onSelect, onNewChat, onSelectFolder, refreshKey, onUnreadChange }: Props) {
  const { t } = useT();
  const { message } = App.useApp();
  const [agents, setAgents] = useState<MergedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editAgent, setEditAgent] = useState<MergedAgent | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MergedAgent | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<DeleteInfo | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [logFolder, setLogFolder] = useState<string | null>(null);
  const [hoveredJid, setHoveredJid] = useState<string | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [convs, groups] = await Promise.all([getConversations(), getGroups()]);
      const groupMap = new Map<string, RegisteredGroupInfo>();
      for (const g of groups) groupMap.set(g.jid, g);

      const seen = new Set<string>();
      const merged: MergedAgent[] = [];

      for (const c of convs) {
        seen.add(c.jid);
        const g = groupMap.get(c.jid);
        merged.push({
          jid: c.jid, name: c.name, channel: c.channel, preview: c.preview,
          lastMessageTime: c.lastMessageTime,
          folder: g?.folder ?? null, trigger: g?.trigger ?? null,
          requiresTrigger: g?.requiresTrigger ?? true, added_at: g?.added_at ?? null,
          containerConfig: g?.containerConfig ?? null,
          unreadCount: c.unreadCount ?? 0,
        });
      }

      for (const g of groups) {
        if (seen.has(g.jid)) continue;
        merged.push({
          jid: g.jid, name: g.name, channel: channelFromJid(g.jid),
          preview: null, lastMessageTime: g.added_at,
          folder: g.folder, trigger: g.trigger,
          requiresTrigger: g.requiresTrigger, added_at: g.added_at,
          containerConfig: g.containerConfig ?? null,
          unreadCount: 0,
        });
      }

      setAgents(merged);
      const total = merged.reduce((sum, a) => sum + a.unreadCount, 0);
      onUnreadChange?.(total);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [refreshKey]);

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeJid, agents]);

  useEffect(() => {
    getAIConfig().then((data) => setProviders(data.providers)).catch(() => {});
  }, []);

  const openDeleteModal = (agent: MergedAgent) => {
    setDeleteTarget(agent);
    setDeleteFiles(false);
    setDeleteInfo(null);
    getDeleteInfo(agent.jid).then(setDeleteInfo).catch(() => {});
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteConversation(deleteTarget.jid, deleteFiles);
      setAgents((prev) => prev.filter((a) => a.jid !== deleteTarget.jid));
      setDeleteTarget(null);
    } catch { /* ignore */ } finally {
      setDeleting(false);
    }
  };

  const handleEdit = (agent: MergedAgent) => {
    setEditAgent(agent);
    form.setFieldsValue({
      name: agent.name, trigger: agent.trigger || '',
      requiresTrigger: agent.requiresTrigger,
      provider: agent.containerConfig?.provider || '',
      model: agent.containerConfig?.model || '',
    });
  };

  const handleSave = async () => {
    if (!editAgent) return;
    setSaving(true);
    try {
      const values = await form.validateFields();
      const containerConfig = values.provider
        ? { provider: values.provider, model: values.model || undefined }
        : null;
      await updateGroup(editAgent.jid, {
        name: values.name, trigger: values.trigger,
        requiresTrigger: values.requiresTrigger, containerConfig,
      });
      message.success(t('group.saved'));
      setEditAgent(null);
      load();
    } catch {
      message.error(t('group.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const formatTime = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return t('chat.justNow');
    if (diff < 3600000) return t('chat.mAgo', { n: String(Math.floor(diff / 60000)) });
    return new Date(ts).toLocaleDateString();
  };

  const buildMenuItems = (item: MergedAgent) => {
    const items: Array<{ key: string; label: string; icon: React.ReactNode; danger?: boolean; children?: Array<{ key: string; label: string }> }> = [];
    if (item.folder) {
      items.push({ key: 'edit', label: t('group.edit'), icon: <EditOutlined /> });
      items.push({ key: 'files', label: t('ws.title'), icon: <FolderOutlined /> });
      items.push({ key: 'logs', label: t('log.title'), icon: <FileTextOutlined /> });
      items.push({
        key: 'export', label: t('chat.exportFirst'), icon: <DownloadOutlined />,
        children: [
          { key: 'export-md', label: 'Markdown (.md)' },
          { key: 'export-json', label: 'JSON (.json)' },
          { key: 'export-csv', label: 'CSV (.csv)' },
        ],
      });
    }
    items.push({ key: 'delete', label: t('task.delete'), icon: <DeleteOutlined />, danger: true });
    return items;
  };

  const handleMenuClick = (key: string, item: MergedAgent) => {
    if (key.startsWith('export-')) {
      const fmt = key.replace('export-', '') as 'md' | 'json' | 'csv';
      window.open(getExportUrl(item.jid, fmt), '_blank');
      return;
    }
    switch (key) {
      case 'edit': handleEdit(item); break;
      case 'files': if (item.folder) onSelectFolder(item.folder); break;
      case 'logs': if (item.folder) setLogFolder(item.folder); break;
      case 'delete': openDeleteModal(item); break;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 12px' }}>
        <Button type="link" icon={<PlusOutlined />} style={{ width: 100, float: 'right' }} onClick={onNewChat}>
          {t('chat.newChat')}
        </Button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
        ) : (
          <div>
            {agents.map((item) => (
              <div
                key={item.jid}
                ref={item.jid === activeJid ? activeRef : undefined}
                onClick={() => onSelect(item.jid, item.name)}
                onMouseEnter={() => setHoveredJid(item.jid)}
                onMouseLeave={() => setHoveredJid(null)}
                style={{
                  cursor: 'pointer',
                  padding: '10px 12px',
                  borderRadius: 8,
                  marginBottom: 2,
                  background: item.jid === activeJid ? 'var(--ant-color-primary-bg)' : 'transparent',
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                  {(() => {
                    const Icon = CHANNEL_ICONS[item.channel];
                    return Icon
                      ? <span style={{ marginTop: 4 }}><Icon size={18} /></span>
                      : <MessageOutlined style={{ fontSize: 18, marginTop: 4 }} />;
                  })()}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text ellipsis style={{ display: 'block', flex: 1, fontWeight: item.unreadCount > 0 ? 600 : 'normal' }}>{item.name || 'Chat'}</Text>
                      <Text type="secondary" style={{ fontSize: 11, marginLeft: 8, flexShrink: 0 }}>
                        {item.lastMessageTime ? formatTime(item.lastMessageTime) : ''}
                      </Text>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text type="secondary" ellipsis style={{ flex: 1, fontSize: 12 }}>
                        {item.preview || (item.folder && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><FolderOutlined style={{ fontSize: 10 }} /> {item.folder}</span>)}
                      </Text>
                      {item.unreadCount > 0 && (
                        <Badge count={item.unreadCount} size="small" style={{ marginLeft: 8, flexShrink: 0 }} />
                      )}
                    </div>
                  </div>
                </div>

                <div className="agent-list-actions" style={{ flexShrink: 0, visibility: hoveredJid === item.jid ? 'visible' : 'hidden', width: 24 }}>
                  <Dropdown
                    menu={{
                      items: buildMenuItems(item),
                      onClick: ({ key }) => handleMenuClick(key, item),
                    }}
                    trigger={['click']}
                    placement="bottomRight"
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<EllipsisOutlined />}
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    />
                  </Dropdown>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        title={t('group.edit')}
        open={!!editAgent}
        onOk={handleSave}
        onCancel={() => setEditAgent(null)}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label={t('group.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('group.trigger')} name="trigger" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('group.requiresTrigger')} name="requiresTrigger" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label={t('group.provider')} name="provider">
            <Select
              allowClear
              placeholder={t('group.useDefault')}
              options={[
                { value: '', label: t('group.useDefault') },
                ...providers.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </Form.Item>
          <Form.Item label={t('group.model')} name="model">
            <Input placeholder={t('group.modelPlaceholder')} allowClear />
          </Form.Item>
          {editAgent && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>JID: {editAgent.jid}</Text>
              {editAgent.folder && (
                <><br /><Text type="secondary" style={{ fontSize: 12 }}>{t('group.folder')}: {editAgent.folder}</Text></>
              )}
            </div>
          )}
        </Form>
      </Modal>

      <Modal
        title={<><ExclamationCircleOutlined style={{ color: 'var(--ant-color-warning)', marginRight: 8 }} />{t('chat.deleteConfirm')}</>}
        open={!!deleteTarget}
        onOk={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        confirmLoading={deleting}
        okButtonProps={{ danger: true }}
        okText="OK"
        cancelText="Cancel"
        destroyOnHidden
      >
        {deleteTarget && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Text>{deleteTarget.name}</Text>
            {deleteInfo?.isLastJid && deleteInfo.hasFiles && (
              <>
                <Checkbox checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)}>
                  {t('chat.deleteFiles')}
                </Checkbox>
                {deleteFiles && (
                  <Text type="warning" style={{ fontSize: 12 }}>
                    {t('chat.deleteFilesWarning', { folder: deleteInfo.folder || '' })}
                  </Text>
                )}
                {deleteFiles && deleteInfo.taskCount > 0 && (
                  <Text type="warning" style={{ fontSize: 12 }}>
                    {t('chat.deleteTasksWarning', { count: String(deleteInfo.taskCount) })}
                  </Text>
                )}
              </>
            )}
            {deleteTarget.folder && (
              <Dropdown
                menu={{
                  items: [
                    { key: 'md', label: 'Markdown (.md)' },
                    { key: 'json', label: 'JSON (.json)' },
                    { key: 'csv', label: 'CSV (.csv)' },
                  ],
                  onClick: ({ key }) => {
                    window.open(getExportUrl(deleteTarget.jid, key as 'json' | 'md' | 'csv'), '_blank');
                  },
                }}
                trigger={['click']}
              >
                <Button size="small" icon={<DownloadOutlined />}>
                  {t('chat.exportFirst')}
                </Button>
              </Dropdown>
            )}
          </div>
        )}
      </Modal>

      <LogViewer folder={logFolder} open={!!logFolder} onClose={() => setLogFolder(null)} />
    </div>
  );
}

function channelFromJid(jid: string): string {
  if (jid.includes('@web.')) return 'web';
  if (jid.includes('@slack.')) return 'slack';
  if (jid.includes('@dingtalk.')) return 'dingtalk';
  if (jid.includes('@qq.')) return 'qq';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  if (jid.includes('tg:')) return 'telegram';
  return 'unknown';
}
