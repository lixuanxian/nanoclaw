import { useEffect, useState } from 'react';
import { Typography, Spin, Button, Modal, Input, Switch, Form, message } from 'antd';
import { EditOutlined, TeamOutlined, FolderOutlined } from '@ant-design/icons';
import { getGroups, updateGroup } from '../api';
import { useT } from '../i18n';
import { CHANNEL_ICONS } from './Icons';
import type { RegisteredGroupInfo } from '../types';

const { Text } = Typography;

function channelFromJid(jid: string): string {
  if (jid.includes('@web.')) return 'web';
  if (jid.includes('@slack.')) return 'slack';
  if (jid.includes('@dingtalk.')) return 'dingtalk';
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  if (jid.includes('tg:')) return 'telegram';
  return 'unknown';
}

interface Props {
  refreshKey: number;
}

export function GroupList({ refreshKey }: Props) {
  const { t } = useT();
  const [groups, setGroups] = useState<RegisteredGroupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editGroup, setEditGroup] = useState<RegisteredGroupInfo | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const data = await getGroups();
      setGroups(data);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const handleEdit = (g: RegisteredGroupInfo) => {
    setEditGroup(g);
    form.setFieldsValue({
      name: g.name,
      trigger: g.trigger,
      requiresTrigger: g.requiresTrigger,
    });
  };

  const handleSave = async () => {
    if (!editGroup) return;
    setSaving(true);
    try {
      const values = await form.validateFields();
      await updateGroup(editGroup.jid, {
        name: values.name,
        trigger: values.trigger,
        requiresTrigger: values.requiresTrigger,
      });
      message.success(t('group.saved'));
      setEditGroup(null);
      load();
    } catch {
      message.error(t('group.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const formatTime = (ts: string) => {
    return new Date(ts).toLocaleDateString();
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>;
  }

  if (groups.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 24 }}>
        <Text type="secondary">{t('group.empty')}</Text>
      </div>
    );
  }

  return (
    <>
      <div style={{ overflow: 'auto', padding: '0 8px', flex: 1 }}>
        {groups.map((g) => {
          const ch = channelFromJid(g.jid);
          const Icon = CHANNEL_ICONS[ch];
          return (
            <div
              key={g.jid}
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                marginBottom: 2,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                {Icon
                  ? <span style={{ marginTop: 4 }}><Icon size={18} /></span>
                  : <TeamOutlined style={{ fontSize: 18, marginTop: 4 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text ellipsis style={{ display: 'block' }}>{g.name}</Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <FolderOutlined style={{ fontSize: 11, opacity: 0.5 }} />
                    <Text type="secondary" ellipsis style={{ fontSize: 12 }}>{g.folder}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {g.trigger && `"${g.trigger}"`}
                    {g.trigger && ' · '}
                    {formatTime(g.added_at)}
                  </Text>
                </div>
              </div>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => handleEdit(g)}
              />
            </div>
          );
        })}
      </div>

      <Modal
        title={t('group.edit')}
        open={!!editGroup}
        onOk={handleSave}
        onCancel={() => setEditGroup(null)}
        confirmLoading={saving}
        destroyOnClose
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
          {editGroup && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                JID: {editGroup.jid}
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('group.folder')}: {editGroup.folder}
              </Text>
            </div>
          )}
        </Form>
      </Modal>
    </>
  );
}
