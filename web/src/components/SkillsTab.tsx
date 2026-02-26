import { useState, useEffect, useCallback } from 'react';
import { Card, Switch, Button, Modal, Form, Input, Typography, Tag, Empty, App } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons';
import { getSkills, createSkill, deleteSkill, toggleSkill, installRemoteSkill } from '../api';
import { useT } from '../i18n';
import type { SkillInfo } from '../types';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

export function SkillsTab() {
  const { t } = useT();
  const { message: antMessage, modal } = App.useApp();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createForm] = Form.useForm();
  const [installForm] = Form.useForm();

  const loadSkills = useCallback(async () => {
    try {
      const data = await getSkills();
      setSkills(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const handleCreate = async (values: { name: string; description: string; content: string }) => {
    setSaving(true);
    try {
      await createSkill(values);
      antMessage.success(t('skills.created'));
      setCreateOpen(false);
      createForm.resetFields();
      loadSkills();
    } catch {
      antMessage.error(t('skills.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleInstall = async (values: { url: string }) => {
    setSaving(true);
    try {
      await installRemoteSkill(values.url);
      antMessage.success(t('skills.installSuccess'));
      setInstallOpen(false);
      installForm.resetFields();
      loadSkills();
    } catch {
      antMessage.error(t('skills.installFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await toggleSkill(id, enabled);
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
  };

  const handleDelete = (id: string, name: string) => {
    modal.confirm({
      title: t('skills.deleteConfirm'),
      content: name,
      onOk: async () => {
        await deleteSkill(id);
        loadSkills();
      },
    });
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text strong>{t('skills.title')}</Text>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            icon={<CloudDownloadOutlined />}
            size="small"
            onClick={() => setInstallOpen(true)}
          >
            {t('skills.installRemote')}
          </Button>
          <Button
            icon={<PlusOutlined />}
            size="small"
            type="primary"
            onClick={() => setCreateOpen(true)}
          >
            {t('skills.addCustom')}
          </Button>
        </div>
      </div>

      {skills.length === 0 && !loading && <Empty description={t('skills.empty')} />}

      {skills.map((skill) => (
        <Card key={skill.id} size="small" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ThunderboltOutlined />
            <Text strong>{skill.name}</Text>
            <Tag color={skill.type === 'builtin' ? 'blue' : 'green'}>
              {t(`skills.type.${skill.type}` as 'skills.type.builtin')}
            </Tag>
            <div style={{ flex: 1 }} />
            {skill.type === 'custom' && (
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleDelete(skill.id, skill.name)}
              />
            )}
            <Switch
              checked={skill.enabled}
              onChange={(v) => handleToggle(skill.id, v)}
              size="small"
            />
          </div>
          {skill.description && (
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
              {skill.description}
            </Paragraph>
          )}
        </Card>
      ))}

      {/* Create Custom Skill Modal */}
      <Modal
        title={t('skills.addCustom')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={saving}
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="name" label={t('skills.name')} rules={[{ required: true }]}>
            <Input placeholder="e.g. code-review" />
          </Form.Item>
          <Form.Item name="description" label={t('skills.description')}>
            <Input placeholder="e.g. Reviews code for best practices" />
          </Form.Item>
          <Form.Item name="content" label={t('skills.content')} rules={[{ required: true }]}>
            <TextArea rows={10} placeholder="# Skill Instructions&#10;&#10;..." />
          </Form.Item>
        </Form>
      </Modal>

      {/* Install Remote Skill Modal */}
      <Modal
        title={t('skills.installRemote')}
        open={installOpen}
        onCancel={() => setInstallOpen(false)}
        onOk={() => installForm.submit()}
        confirmLoading={saving}
      >
        <Form form={installForm} layout="vertical" onFinish={handleInstall}>
          <Form.Item
            name="url"
            label={t('skills.installUrl')}
            rules={[{ required: true }, { type: 'url', message: 'Please enter a valid URL' }]}
          >
            <Input placeholder="https://raw.githubusercontent.com/.../SKILL.md" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
