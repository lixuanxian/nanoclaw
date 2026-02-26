import { useEffect, useState } from 'react';
import { Button, Typography, Popconfirm, Spin } from 'antd';
import { PlusOutlined, DeleteOutlined, MessageOutlined } from '@ant-design/icons';
import { getConversations, deleteConversation } from '../api';
import { useT } from '../i18n';
import { CHANNEL_ICONS } from './Icons';
import type { Conversation } from '../types';

const { Text } = Typography;

interface Props {
  activeJid: string | null;
  onSelect: (jid: string, name: string) => void;
  onNewChat: () => void;
  refreshKey: number;
}

export function SessionList({ activeJid, onSelect, onNewChat, refreshKey }: Props) {
  const { t } = useT();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await getConversations();
      setConversations(Array.isArray(data) ? data : []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const handleDelete = async (jid: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await deleteConversation(jid);
      setConversations((prev) => prev.filter((c) => c.jid !== jid));
    } catch {
      // ignore
    }
  };

  const formatTime = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return t('chat.justNow');
    if (diff < 3600000) return t('chat.mAgo', { n: String(Math.floor(diff / 60000)) });
    return new Date(ts).toLocaleDateString();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 16px' }}>
        <Button type="primary" icon={<PlusOutlined />} block onClick={onNewChat}>
          {t('chat.newChat')}
        </Button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
        ) : (
          <div>
            {conversations.map((item) => (
              <div
                key={item.jid}
                onClick={() => onSelect(item.jid, item.name)}
                style={{
                  cursor: 'pointer',
                  padding: '10px 12px',
                  borderRadius: 8,
                  marginBottom: 2,
                  background: item.jid === activeJid ? 'var(--ant-color-primary-bg)' : 'transparent',
                  border: 'none',
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
                    <Text ellipsis style={{ display: 'block' }}>{item.name || 'Chat'}</Text>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text type="secondary" ellipsis style={{ flex: 1, fontSize: 12 }}>
                        {item.preview}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 11, marginLeft: 8, flexShrink: 0 }}>
                        {item.lastMessageTime ? formatTime(item.lastMessageTime) : ''}
                      </Text>
                    </div>
                  </div>
                </div>

                <Popconfirm
                  title={t('chat.deleteConfirm')}
                  onConfirm={(e) => handleDelete(item.jid, e as unknown as React.MouseEvent)}
                  onCancel={(e) => e?.stopPropagation()}
                  okText="OK"
                  cancelText="Cancel"
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
