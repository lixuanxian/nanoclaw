import { useState } from 'react';
import { Card, Form, Input, Typography, Tag, Button } from 'antd';
import { EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons';
import { useT } from '../i18n';
import { PROVIDER_ICONS } from './Icons';
import type { ProviderInfo } from '../types';

const { Text } = Typography;

interface Props {
  provider: ProviderInfo;
  config: { model?: string; api_base?: string; api_key?: string };
  isDefault: boolean;
  hasExistingKey?: boolean;
  onChange: (values: { model?: string; api_base?: string; api_key?: string }) => void;
}

// Providers that only need a model field (uses CLI credentials)
const CLI_ONLY = new Set(['claude', 'copilot']);
// Providers that need model + API URL + API key
const FULL_CONFIG = new Set(['claude-compatible', 'openai-compatible']);

export function ProviderCard({ provider, config, isDefault, hasExistingKey, onChange }: Props) {
  const { t } = useT();
  const isCli = CLI_ONLY.has(provider.id);
  const isFull = FULL_CONFIG.has(provider.id);
  const [keyVisible, setKeyVisible] = useState(false);

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

      {/* Hidden dummy fields to absorb browser autofill */}
      <div style={{ position: 'absolute', opacity: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <input type="text" name="prevent_autofill_username" tabIndex={-1} autoComplete="username" />
        <input type="password" name="prevent_autofill_password" tabIndex={-1} autoComplete="current-password" />
      </div>

      <Form layout="vertical" size="small" autoComplete="off" style={{ marginBottom: -8 }}>
        <Form.Item label={t('ai.model')} style={{ marginBottom: 12 }}>
          <Input
            value={config.model || ''}
            placeholder={provider.defaultModel || t('ai.model')}
            autoComplete="off"
            name={`nc_model_${provider.id}`}
            data-form-type="other"
            onChange={(e) => onChange({ ...config, model: e.target.value })}
          />
        </Form.Item>

        {(isFull || (!isCli && provider.apiBase !== undefined)) && (
          <Form.Item label={t('ai.apiUrl')} style={{ marginBottom: 12 }}>
            <Input
              value={config.api_base || ''}
              placeholder={provider.apiBase || t('ai.apiUrl')}
              autoComplete="off"
              name={`nc_apiurl_${provider.id}`}
              data-form-type="other"
              onChange={(e) => onChange({ ...config, api_base: e.target.value })}
            />
          </Form.Item>
        )}

        {!isCli && (
          <Form.Item label={t('ai.apiKey')} style={{ marginBottom: 12 }}>
            <Input
              type={keyVisible ? 'text' : 'password'}
              value={config.api_key || ''}
              placeholder={
                hasExistingKey && !config.api_key
                  ? t('ai.apiKeySet')
                  : t('ai.enterApiKey')
              }
              autoComplete="off"
              name={`nc_apikey_${provider.id}`}
              data-lpignore="true"
              data-form-type="other"
              data-1p-ignore
              readOnly
              onFocus={(e) => { e.currentTarget.removeAttribute('readonly'); }}
              onChange={(e) => onChange({ ...config, api_key: e.target.value })}
              suffix={
                <Button
                  type="text"
                  size="small"
                  icon={keyVisible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                  onClick={() => setKeyVisible((v) => !v)}
                  style={{ border: 'none', padding: 0, height: 'auto' }}
                />
              }
            />
          </Form.Item>
        )}
      </Form>
    </Card>
  );
}
