import { useState, useEffect, useCallback } from 'react';
import {
  Layout,
  Tabs,
  Select,
  Button,
  Segmented,
  Typography,
  Card,
  App,
  Space,
  Badge,
} from 'antd';
import {
  ArrowLeftOutlined,
  LogoutOutlined,
  DesktopOutlined,
  MoonOutlined,
  SunOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { getAIConfig, saveAIConfig, getChannels, logout } from '../api';
import { useT } from '../i18n';
import { saveTheme } from '../theme';
import { ProviderCard } from '../components/ProviderCard';
import { ChannelCard } from '../components/ChannelCard';
import { ThemeToggle } from '../components/ThemeToggle';
import { LanguageToggle } from '../components/LanguageToggle';
import { SkillsTab } from '../components/SkillsTab';
import { CHANNEL_ICONS, PROVIDER_ICONS, USFlag, CNFlag } from '../components/Icons';
import type { ThemeMode, ProviderInfo, ChannelInfo } from '../types';

const { Content, Header } = Layout;
const { Title, Text } = Typography;

const TAB_OVERLAY_STYLE: React.CSSProperties = {
  margin: '0 auto',
  paddingBottom: 24,
  width: 'calc(100vw - 24px)',
  height: `calc(100vh - 48px - 56px)`,
  overflowY: 'auto',
  overflowX: 'hidden',
};

const TAB_CONTENT_STYLE: React.CSSProperties = {
  margin: '0 auto',
  width: '100%',
  maxWidth: 800,
  height: `calc(100vh - 48px - 56px - 24px)`,
  padding: 24,
};

const TAB_CONTENT_LIMIT_STYLE: React.CSSProperties = {
  maxWidth: 600,
  margin: '0 auto',
};

interface Props {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

const STATUS_DOT: Record<string, string> = {
  connected: 'success',
  authenticated: 'success',
  configured: 'warning',
  not_configured: 'default',
  connecting: 'processing',
  qr_ready: 'processing',
  error: 'error',
};

// Providers that only need a model field (uses CLI credentials)
const CLI_ONLY_PROVIDERS = new Set(['claude']);

/** Compute Badge status for an AI provider. */
function providerStatus(
  id: string,
  defaultProvider: string,
  config: { model?: string; api_base?: string; api_key?: string } | undefined,
): string {
  const isDefault = id === defaultProvider;
  const hasKey = !!config?.api_key;
  const hasConfig = !!(config?.model || config?.api_base || config?.api_key);

  if (isDefault) {
    // Claude CLI doesn't need API key
    if (CLI_ONLY_PROVIDERS.has(id)) return 'success';
    return hasKey ? 'success' : 'error';
  }
  return hasConfig ? 'warning' : 'default';
}

const TAB_SLUG_TO_KEY: Record<string, string> = {
  'ai-model': 'ai',
  channels: 'channels',
  skills: 'skills',
  user: 'user',
};
const TAB_KEY_TO_SLUG: Record<string, string> = {
  ai: 'ai-model',
  channels: 'channels',
  skills: 'skills',
  user: 'user',
};

export function SettingsPage({ themeMode, setThemeMode }: Props) {
  const { t, lang, setLang } = useT();
  const { message: antMessage } = App.useApp();
  const navigate = useNavigate();
  const { tab: tabSlug } = useParams<{ tab?: string }>();

  const activeTab = TAB_SLUG_TO_KEY[tabSlug || ''] || 'ai';
  const setActiveTab = (key: string) => {
    navigate(`/settings/${TAB_KEY_TO_SLUG[key] || 'ai-model'}`, { replace: true });
  };

  // AI config state
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState('');
  const [providerConfigs, setProviderConfigs] = useState<
    Record<string, { model?: string; api_base?: string; api_key?: string }>
  >({});
  const [aiSaving, setAiSaving] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>('');

  // Channel state
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string>('');

  const loadAIConfig = useCallback(async () => {
    try {
      const data = await getAIConfig();
      const list = Array.isArray(data.providers) ? data.providers : [];
      setProviders(list);
      setDefaultProvider(data.config?.default_provider || '');
      setProviderConfigs(data.config?.providers || {});
      if (list.length > 0) setSelectedProvider((prev) => prev || list[0].id);
    } catch {
      /* ignore */
    }
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const data = await getChannels();
      const list = Array.isArray(data) ? data : [];
      setChannels(list);
      if (list.length > 0) setSelectedChannel((prev) => prev || list[0].id);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadAIConfig();
    loadChannels();
  }, [loadAIConfig, loadChannels]);

  const handleAISave = async () => {
    setAiSaving(true);
    try {
      await saveAIConfig({
        default_provider: defaultProvider,
        providers: providerConfigs,
      });
      antMessage.success(t('ai.saved'));
    } catch {
      antMessage.error('Save failed');
    } finally {
      setAiSaving(false);
    }
  };

  const handleProviderChange = (
    id: string,
    values: { model?: string; api_base?: string; api_key?: string },
  ) => {
    setProviderConfigs((prev) => ({ ...prev, [id]: values }));
  };

  const handleThemeChange = (value: string) => {
    const mode = value as ThemeMode;
    saveTheme(mode);
    setThemeMode(mode);
  };

  const tabItems = [
    {
      key: 'ai',
      label: t('settings.tabAi'),
      children: (
        <div style={TAB_OVERLAY_STYLE}>
          <div style={TAB_CONTENT_STYLE}>
            <Card size="small" style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                {t('ai.defaultProvider')}
              </Text>
              <Select
                value={defaultProvider}
                onChange={setDefaultProvider}
                style={{ width: '100%' }}
                options={providers.map((p) => {
                  const Icon = PROVIDER_ICONS[p.id];
                  return {
                    value: p.id,
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {Icon && <Icon size={14} />}
                        {p.name}
                      </span>
                    ),
                  };
                })}
              />
            </Card>

            {providers.length > 0 && (
              <Segmented
                block
                value={selectedProvider || providers[0]?.id}
                onChange={(val) => setSelectedProvider(val as string)}
                options={providers.map((p) => {
                  const Icon = PROVIDER_ICONS[p.id];
                  const dot = providerStatus(p.id, defaultProvider, providerConfigs[p.id]);
                  return {
                    value: p.id,
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Badge status={dot as 'success'} />
                        {Icon && <Icon size={14} />}
                        {p.name}
                      </span>
                    ),
                  };
                })}
                style={{ marginBottom: 16 }}
              />
            )}
            {providers
              .filter((p) => p.id === (selectedProvider || providers[0]?.id))
              .map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  config={providerConfigs[p.id] || {}}
                  isDefault={p.id === defaultProvider}
                  onChange={(v) => handleProviderChange(p.id, v)}
                />
              ))}

            <div
              style={{
                position: 'sticky',
                bottom: 0,
                paddingTop: 16,
                paddingBottom: 4,
                marginTop: 16,
              }}
            >
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={handleAISave}
                loading={aiSaving}
                block
                size="large"
              >
                {t('ai.save')}
              </Button>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'channels',
      label: t('settings.tabChannels'),
      children: (
        <div style={TAB_OVERLAY_STYLE}>
          <div style={TAB_CONTENT_STYLE}>
            {channels.length > 0 && (
              <Segmented
                block
                value={selectedChannel || channels[0]?.id}
                onChange={(val) => setSelectedChannel(val as string)}
                options={channels.map((ch) => {
                  const Icon = CHANNEL_ICONS[ch.id];
                  return {
                    value: ch.id,
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Badge status={(STATUS_DOT[ch.status] || 'default') as 'success'} />
                        {Icon && <Icon size={14} />}
                        {ch.name}
                      </span>
                    ),
                  };
                })}
                style={{ marginBottom: 16 }}
              />
            )}
            {channels
              .filter((ch) => ch.id === (selectedChannel || channels[0]?.id))
              .map((ch) => (
                <ChannelCard
                  key={ch.id}
                  channel={ch}
                  onRefresh={loadChannels}
                />
              ))}
          </div>
        </div>
      ),
    },
    {
      key: 'skills',
      label: t('settings.tabSkills'),
      children: (
        <div style={TAB_OVERLAY_STYLE}>
          <div style={{...TAB_CONTENT_STYLE, ...TAB_CONTENT_LIMIT_STYLE}}>
            <SkillsTab />
          </div>
        </div>
      ),
    },
    {
      key: 'user',
      label: t('settings.tabUser'),
      children: (
        <div style={TAB_OVERLAY_STYLE}>
          <div style={{...TAB_CONTENT_STYLE, ...TAB_CONTENT_LIMIT_STYLE}}>
            <Card size="small" style={{ marginBottom: 16 }}>
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>
                    {t('user.theme')}
                  </Text>
                  <Segmented
                    value={themeMode}
                    onChange={handleThemeChange}
                    options={[
                      {
                        value: 'system',
                        label: <DesktopOutlined />,
                        title: t('user.themeSystem'),
                      },
                      {
                        value: 'dark',
                        label: <MoonOutlined />,
                        title: t('user.themeDark'),
                      },
                      {
                        value: 'light',
                        label: <SunOutlined />,
                        title: t('user.themeLight'),
                      },
                    ]}
                  />
                </div>

                <div>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>
                    {t('user.language')}
                  </Text>
                  <Segmented
                    value={
                      lang === 'system'
                        ? navigator.language.startsWith('zh')
                          ? 'zh-CN'
                          : 'en'
                        : lang
                    }
                    onChange={(value) => setLang(value as 'en' | 'zh-CN')}
                    options={[
                      {
                        value: 'system',
                        label: <DesktopOutlined />,
                        title: t('user.langSystem'),
                      },
                      {
                        value: 'en',
                        label: <USFlag />,
                        title: t('user.langEnglish'),
                      },
                      {
                        value: 'zh-CN',
                        label: <CNFlag />,
                        title: t('user.langChinese'),
                      },
                    ]}
                  />
                </div>
              </Space>
            </Card>

            <Button icon={<LogoutOutlined />} danger block onClick={logout}>
              {t('user.logout')}
            </Button>
          </div>
        </div>
      ),
    },
  ];

  return (
    <Layout style={{ height: '100%' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          height: 48,
          borderBottom: '1px solid var(--ant-color-border)',
          gap: 12,
        }}
      >
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate('/')}
        />
        <Title level={5} style={{ margin: 0 }}>
          {t('settings.title')}
        </Title>
        <div style={{ flex: 1 }} />
        <LanguageToggle lang={lang} setLang={setLang} />
        <ThemeToggle themeMode={themeMode} setThemeMode={setThemeMode} />
      </Header>

      <Content
        className="settings-content"
        style={{
          display: 'flex',
          flexDirection: 'column',
          padding: '0 24px',
        }}
      >
        <Tabs
          className="settings-tabs"
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
        />
      </Content>
    </Layout>
  );
}
