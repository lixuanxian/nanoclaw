import { Card, Form, Input, Typography, Tag } from 'antd';
import { useT } from '../i18n';
import { PROVIDER_ICONS } from './Icons';
import type { ProviderInfo } from '../types';

const { Text } = Typography;

interface Props {
  provider: ProviderInfo;
  config: { model?: string; api_base?: string; api_key?: string };
  isDefault: boolean;
  onChange: (values: { model?: string; api_base?: string; api_key?: string }) => void;
}

// Providers that only need a model field (uses CLI credentials)
const CLI_ONLY = new Set(['claude']);
// Providers that need model + API URL + API key
const FULL_CONFIG = new Set(['claude-compatible', 'openai-compatible']);

export function ProviderCard({ provider, config, isDefault, onChange }: Props) {
  const { t } = useT();
  const isCli = CLI_ONLY.has(provider.id);
  const isFull = FULL_CONFIG.has(provider.id);

  return (
    <Card
      size="small"
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {PROVIDER_ICONS[provider.id] && (() => { const Icon = PROVIDER_ICONS[provider.id]; return <Icon size={16} />; })()}
          {provider.name}
          {isDefault && <Tag color="blue" style={{ marginLeft: 8 }}>{t('ai.default')}</Tag>}
        </span>
      }
    >
      {isCli && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
          {t('ai.claudeHint')}
        </Text>
      )}

      <Form layout="vertical" size="small" autoComplete="off" style={{ marginBottom: -8 }}>
        <Form.Item label={t('ai.model')} style={{ marginBottom: 12 }}>
          <Input
            value={config.model || ''}
            placeholder={provider.defaultModel || t('ai.model')}
            autoComplete="off"
            onChange={(e) => onChange({ ...config, model: e.target.value })}
          />
        </Form.Item>

        {(isFull || (!isCli && provider.apiBase !== undefined)) && (
          <Form.Item label={t('ai.apiUrl')} style={{ marginBottom: 12 }}>
            <Input
              value={config.api_base || ''}
              placeholder={provider.apiBase || t('ai.apiUrl')}
              autoComplete="off"
              onChange={(e) => onChange({ ...config, api_base: e.target.value })}
            />
          </Form.Item>
        )}

        {!isCli && (
          <Form.Item label={t('ai.apiKey')} style={{ marginBottom: 12 }}>
            <Input.Password
              value={config.api_key || ''}
              placeholder={t('ai.enterApiKey')}
              autoComplete="new-password"
              onChange={(e) => onChange({ ...config, api_key: e.target.value })}
            />
          </Form.Item>
        )}
      </Form>
    </Card>
  );
}
