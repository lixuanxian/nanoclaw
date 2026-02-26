import { useState } from 'react';
import { Card, Switch, Form, Input, Button, Collapse, Typography, Badge, App } from 'antd';
import { saveChannelConfig, enableChannel, disableChannel, startWhatsApp, getWhatsAppStatus } from '../api';
import { useT } from '../i18n';
import { CHANNEL_ICONS } from './Icons';
import type { ChannelInfo } from '../types';

const { Text } = Typography;

interface Props {
  channel: ChannelInfo;
  onRefresh: () => void;
}

const statusColors: Record<string, string> = {
  connected: 'green',
  authenticated: 'green',
  configured: 'orange',
  not_configured: 'default',
  connecting: 'processing',
  qr_ready: 'processing',
};

export function ChannelCard({ channel, onRefresh }: Props) {
  const { t } = useT();
  const { message: antMessage } = App.useApp();
  const [config, setConfig] = useState<Record<string, string>>(channel.config || {});
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [waStatus, setWaStatus] = useState<string>(channel.status);
  const [qrData, setQrData] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveChannelConfig(channel.id, config);
      antMessage.success(t('ch.saved'));
      onRefresh();
    } catch {
      antMessage.error('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (checked: boolean) => {
    setToggling(true);
    try {
      if (checked) {
        await enableChannel(channel.id);
      } else {
        await disableChannel(channel.id);
      }
      onRefresh();
    } catch {
      antMessage.error('Toggle failed');
    } finally {
      setToggling(false);
    }
  };

  const handleWhatsAppConnect = async () => {
    setWaStatus('connecting');
    try {
      await startWhatsApp();
      // Poll for QR / auth status
      const poll = async () => {
        try {
          const data = await getWhatsAppStatus();
          setWaStatus(data.status);
          if (data.qr) setQrData(data.qr);
          if (data.status === 'authenticated') {
            setQrData(null);
            onRefresh();
            return;
          }
          if (data.status === 'qr_ready' || data.status === 'connecting') {
            setTimeout(poll, 2000);
          }
        } catch {
          setWaStatus('not_configured');
        }
      };
      poll();
    } catch {
      setWaStatus('not_configured');
      antMessage.error(t('ch.startFailed'));
    }
  };

  const statusColor = statusColors[waStatus] || statusColors[channel.status] || 'default';
  const displayStatus = channel.id === 'whatsapp' ? waStatus : channel.status;

  return (
    <Card
      size="small"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge status={statusColor as 'success'} />
          {CHANNEL_ICONS[channel.id] && (() => { const Icon = CHANNEL_ICONS[channel.id]; return <Icon size={16} />; })()}
          <span>{channel.name}</span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {displayStatus === 'connected' || displayStatus === 'authenticated'
              ? t('ch.connected')
              : displayStatus}
          </Text>
        </div>
      }
      extra={
        channel.configurable && (
          <Switch
            checked={channel.enabled}
            onChange={handleToggle}
            loading={toggling}
          />
        )
      }
    >
      {channel.fields && channel.fields.length > 0 && (
        <Form layout="vertical" size="small" autoComplete="off">
          {channel.fields.map((field) => (
            <Form.Item key={field.key} label={field.label}>
              <Input
                type={field.type === 'password' ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={config[field.key] || ''}
                autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                onChange={(e) => setConfig({ ...config, [field.key]: e.target.value })}
              />
            </Form.Item>
          ))}
          <Form.Item>
            <Button type="primary" size="small" onClick={handleSave} loading={saving}>
              {t('ai.save')}
            </Button>
          </Form.Item>
        </Form>
      )}

      {channel.id === 'whatsapp' && (
        <div style={{ marginTop: 8 }}>
          {waStatus !== 'authenticated' && waStatus !== 'connected' && (
            <Button
              type="primary"
              size="small"
              onClick={handleWhatsAppConnect}
              loading={waStatus === 'connecting'}
            >
              {waStatus === 'connecting' ? t('ch.connecting') : t('ch.connect')}
            </Button>
          )}
          {qrData && (
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                {t('ch.scanQr')}
              </Text>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}`}
                alt="QR Code"
                style={{ borderRadius: 8 }}
              />
            </div>
          )}
        </div>
      )}

      {channel.guideKeys && channel.guideKeys.length > 0 && (
        <Collapse
          ghost
          size="small"
          items={[{
            key: 'guide',
            label: t('ch.setupGuide'),
            children: (
              <ol style={{ paddingLeft: 20, margin: 0 }}>
                {channel.guideKeys.map((key, i) => (
                  <li key={i} style={{ marginBottom: 8 }}>
                    <span dangerouslySetInnerHTML={{ __html: t(key) }} />
                  </li>
                ))}
              </ol>
            ),
          }]}
        />
      )}
    </Card>
  );
}
