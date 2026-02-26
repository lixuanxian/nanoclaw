import { useState, useEffect } from 'react';
import { Tag, Popover, Checkbox, Typography, Spin } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { getSkills } from '../api';
import { useT } from '../i18n';
import type { SkillInfo } from '../types';

const { Text } = Typography;

interface Props {
  selected: string[];
  onChange: (skills: string[]) => void;
}

export function SkillsPicker({ selected, onChange }: Props) {
  const { t } = useT();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSkills()
      .then((s) => setSkills(s.filter((sk) => sk.enabled)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin size="small" />;
  if (skills.length === 0) return null;

  const content = (
    <div style={{ maxWidth: 300 }}>
      {skills.map((s) => (
        <div key={s.id} style={{ padding: '4px 0' }}>
          <Checkbox
            checked={selected.includes(s.id)}
            onChange={(e) => {
              if (e.target.checked) {
                onChange([...selected, s.id]);
              } else {
                onChange(selected.filter((id) => id !== s.id));
              }
            }}
          >
            <Text strong style={{ fontSize: 13 }}>{s.name}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 11 }}>{s.description}</Text>
          </Checkbox>
        </div>
      ))}
    </div>
  );

  return (
    <Popover content={content} title={t('chat.skills')} trigger="click" placement="topLeft">
      <Tag
        icon={<ThunderboltOutlined />}
        color={selected.length > 0 ? 'blue' : 'default'}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        {t('chat.skills')}{selected.length > 0 ? ` (${selected.length})` : ''}
      </Tag>
    </Popover>
  );
}
