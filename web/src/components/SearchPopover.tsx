import { useState, useRef } from 'react';
import { Popover, Input, Typography, Button, Spin, Empty, Switch } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import DOMPurify from 'dompurify';
import { searchMessages as searchApi, aiSearchMessages } from '../api';
import { useT } from '../i18n';
import type { SearchResult } from '../types';

const { Text } = Typography;

interface Props {
  onNavigate: (chatJid: string, name: string, messageTimestamp?: string, searchQuery?: string) => void;
}

/** Resolve the effective locale string from the i18n lang setting. */
function resolveLocale(lang: string): string {
  if (lang !== 'system') return lang;
  return navigator.language.startsWith('zh') ? 'zh-CN' : 'en';
}

export function SearchPopover({ onNavigate }: Props) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const [aiKeywords, setAiKeywords] = useState('');
  const [aiError, setAiError] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleSearch = (value: string, useAi = aiMode) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    if (!value.trim()) {
      setResults([]);
      setAiKeywords('');
      setAiError('');
      return;
    }
    const delay = useAi ? 600 : 300;
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      setAiKeywords('');
      setAiError('');
      try {
        if (useAi) {
          const locale = resolveLocale(lang);
          const data = await aiSearchMessages(value.trim(), undefined, 20, 0, locale);
          setResults(data.results);
          setAiKeywords(data.aiKeywords);
          if (data.error) setAiError(data.error);
        } else {
          const data = await searchApi(value.trim());
          setResults(data);
        }
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, delay);
  };

  const toggleAiMode = (checked: boolean) => {
    setAiMode(checked);
    if (query.trim()) handleSearch(query, checked);
  };

  const content = (
    <div style={{ width: 360, maxHeight: 420, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input
          placeholder={t('search.placeholder')}
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          allowClear
          autoFocus
          prefix={<SearchOutlined style={{ opacity: 0.4 }} />}
          style={{ flex: 1 }}
        />
        <Switch
          size="small"
          checked={aiMode}
          onChange={toggleAiMode}
          checkedChildren={t('search.aiMode')}
          unCheckedChildren={t('search.aiMode')}
        />
      </div>
      {aiKeywords && (
        <Text type="secondary" style={{ fontSize: 11, marginTop: 4 }}>
          {t('search.aiKeywords', { keywords: aiKeywords })}
        </Text>
      )}
      {aiError && (
        <Text type="warning" style={{ fontSize: 11, marginTop: 4 }}>
          {t('search.aiError')}
        </Text>
      )}
      <div style={{ marginTop: 8, overflow: 'auto', flex: 1, maxHeight: 360 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin size="small" /></div>
        ) : query.trim() && results.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('search.noResults')} />
        ) : (
          results.map((r) => (
            <div
              key={`${r.id}-${r.chatJid}`}
              onClick={() => {
                onNavigate(r.chatJid, r.sender, r.timestamp, aiMode && aiKeywords ? aiKeywords : query.trim());
                setOpen(false);
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                borderRadius: 6,
                marginBottom: 2,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ant-color-bg-text-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Text style={{ fontSize: 12, display: 'block' }} type="secondary">
                {r.sender}
              </Text>
              <div
                style={{ fontSize: 13 }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(r.snippet, { ALLOWED_TAGS: ['mark'] }) }}
              />
              <Text type="secondary" style={{ fontSize: 11 }}>
                {new Date(r.timestamp).toLocaleString()}
              </Text>
            </div>
          ))
        )}
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
    >
      <Button type="text" icon={<SearchOutlined />} />
    </Popover>
  );
}
