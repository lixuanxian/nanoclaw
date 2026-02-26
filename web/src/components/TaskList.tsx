import { useEffect, useState } from 'react';
import { Typography, Spin, Button, Modal, Input, InputNumber, Select, Form, message, Popconfirm, Tag, Tooltip, Space } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ClockCircleOutlined, PauseCircleOutlined, PlayCircleOutlined, FolderOutlined } from '@ant-design/icons';
import { getTasks, getGroups, createTaskApi, updateTaskApi, deleteTaskApi } from '../api';
import { useT } from '../i18n';
import type { ScheduledTaskInfo, RegisteredGroupInfo } from '../types';

const { Text } = Typography;
const { TextArea } = Input;

interface Props {
  refreshKey: number;
  activeTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
  onGoToAgent?: (jid: string, name: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  paused: 'orange',
  completed: 'default',
};

function formatIntervalHuman(ms: string): string {
  const n = parseInt(ms, 10);
  if (isNaN(n)) return ms;
  if (n >= 86400000) return `${(n / 86400000).toFixed(n % 86400000 === 0 ? 0 : 1)}d`;
  if (n >= 3600000) return `${(n / 3600000).toFixed(n % 3600000 === 0 ? 0 : 1)}h`;
  if (n >= 60000) return `${(n / 60000).toFixed(n % 60000 === 0 ? 0 : 1)}min`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}s`;
  return `${n}ms`;
}

function decomposeInterval(ms: number): { num: number; unit: number } {
  if (ms >= 86400000 && ms % 86400000 === 0) return { num: ms / 86400000, unit: 86400000 };
  if (ms >= 3600000 && ms % 3600000 === 0) return { num: ms / 3600000, unit: 3600000 };
  if (ms >= 60000 && ms % 60000 === 0) return { num: ms / 60000, unit: 60000 };
  return { num: ms / 1000, unit: 1000 };
}

export function TaskList({ refreshKey, activeTaskId, onSelectTask, onGoToAgent }: Props) {
  const { t } = useT();
  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [groups, setGroups] = useState<RegisteredGroupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTaskInfo | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [intervalNum, setIntervalNum] = useState<number>(1);
  const [intervalUnit, setIntervalUnit] = useState<number>(3600000);

  const load = async () => {
    try {
      const [taskData, groupData] = await Promise.all([getTasks(), getGroups()]);
      setTasks(taskData);
      setGroups(groupData);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const openCreate = () => {
    setEditTask(null);
    form.resetFields();
    setIntervalNum(1);
    setIntervalUnit(3600000);
    form.setFieldsValue({
      schedule_type: 'cron',
      context_mode: 'isolated',
      chat_jid: groups[0]?.jid || '',
      group_folder: groups[0]?.folder || '',
    });
    setModalOpen(true);
  };

  const openEdit = (task: ScheduledTaskInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTask(task);
    if (task.schedule_type === 'interval') {
      const ms = parseInt(task.schedule_value, 10);
      if (!isNaN(ms)) {
        const { num, unit } = decomposeInterval(ms);
        setIntervalNum(num);
        setIntervalUnit(unit);
      }
    }
    form.setFieldsValue({
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode,
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      status: task.status,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      if (values.schedule_type === 'interval') {
        values.schedule_value = String(Math.round(intervalNum * intervalUnit));
      }
      if (editTask) {
        await updateTaskApi(editTask.id, {
          prompt: values.prompt,
          schedule_type: values.schedule_type,
          schedule_value: values.schedule_value,
          status: values.status,
          context_mode: values.context_mode,
        });
        message.success(t('task.saved'));
      } else {
        await createTaskApi({
          group_folder: values.group_folder,
          chat_jid: values.chat_jid,
          prompt: values.prompt,
          schedule_type: values.schedule_type,
          schedule_value: values.schedule_value,
          context_mode: values.context_mode,
        });
        message.success(t('task.created'));
      }
      setModalOpen(false);
      load();
    } catch {
      message.error(editTask ? t('task.saveFailed') : t('task.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteTaskApi(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch { /* ignore */ }
  };

  const handleToggleStatus = async (task: ScheduledTaskInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus = task.status === 'active' ? 'paused' : 'active';
    try {
      await updateTaskApi(task.id, { status: newStatus });
      load();
    } catch { /* ignore */ }
  };

  const formatTime = (ts: string | null) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
  };

  const scheduleLabel = (type: string) => {
    if (type === 'cron') return t('task.cron');
    if (type === 'interval') return t('task.interval');
    return t('task.once');
  };

  const scheduleDisplay = (type: string, value: string) => {
    if (type === 'interval') return formatIntervalHuman(value);
    return value;
  };

  const schedulePlaceholder = (type: string) => {
    if (type === 'cron') return t('task.cronPlaceholder');
    if (type === 'interval') return t('task.intervalPlaceholder');
    return t('task.oncePlaceholder');
  };

  const scheduleValueLabel = () => t('task.scheduleValue');

  const scheduleType = Form.useWatch('schedule_type', form);

  const conversationOptions = groups.map((g) => ({
    label: `${g.name} (${g.folder})`,
    value: g.jid,
  }));

  const hasNoAgents = groups.length === 0;

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 16px' }}>
        <Tooltip title={hasNoAgents ? t('task.noAgents') : undefined}>
          <Button type="primary" icon={<PlusOutlined />} block onClick={openCreate} disabled={hasNoAgents}>
            {t('task.create')}
          </Button>
        </Tooltip>
        {hasNoAgents && (
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4, textAlign: 'center' }}>
            {t('task.noAgents')}
          </Text>
        )}
      </div>

      <div style={{ overflow: 'auto', padding: '0 8px', flex: 1 }}>
        {tasks.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Text type="secondary">{t('task.empty')}</Text>
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              onClick={() => onSelectTask?.(task.id)}
              style={{
                cursor: onSelectTask ? 'pointer' : 'default',
                padding: '10px 12px',
                borderRadius: 8,
                marginBottom: 4,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                background: task.id === activeTaskId
                  ? 'var(--ant-color-primary-bg)'
                  : 'var(--ant-color-bg-container)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <ClockCircleOutlined style={{ fontSize: 16, marginTop: 3, opacity: 0.6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text ellipsis style={{ display: 'block', fontSize: 13 }}>
                    {task.prompt}
                  </Text>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
                    <Tag color={STATUS_COLORS[task.status] || 'default'} style={{ margin: 0 }}>
                      {t(`task.${task.status}` as 'task.active')}
                    </Tag>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {scheduleLabel(task.schedule_type)}: {scheduleDisplay(task.schedule_type, task.schedule_value)}
                    </Text>
                  </div>
                  <Text
                    type="secondary"
                    style={{ fontSize: 11, cursor: onGoToAgent ? 'pointer' : 'default' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!onGoToAgent) return;
                      const g = groups.find((g) => g.jid === task.chat_jid);
                      onGoToAgent(task.chat_jid, g?.name || task.chat_jid);
                    }}
                  >
                    <span style={{ textDecoration: onGoToAgent ? 'underline' : 'none' }}>
                      {groups.find((g) => g.jid === task.chat_jid)?.name || task.chat_jid}
                    </span>
                    <span style={{ marginLeft: 6, textDecoration: 'none' }}>
                      <FolderOutlined style={{ fontSize: 10 }} /> {task.group_folder}
                    </span>
                  </Text>
                  {task.next_run && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {t('task.nextRun')}: {formatTime(task.next_run)}
                    </Text>
                  )}
                  {task.last_result && (
                    <Tooltip title={task.last_result}>
                      <Text type="secondary" ellipsis style={{ fontSize: 11, display: 'block' }}>
                        {t('task.lastResult')}: {task.last_result}
                      </Text>
                    </Tooltip>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  <Button
                    type="text"
                    size="small"
                    icon={task.status === 'active' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                    onClick={(e) => handleToggleStatus(task, e)}
                  />
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={(e) => openEdit(task, e)}
                  />
                  <Popconfirm
                    title={t('task.deleteConfirm')}
                    onConfirm={(e) => handleDelete(task.id, e as unknown as React.MouseEvent)}
                    onCancel={(e) => e?.stopPropagation()}
                    okText="OK"
                    cancelText="Cancel"
                  >
                    <Button type="text" size="small" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <Modal
        title={editTask ? t('task.edit') : t('task.create')}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {editTask ? (
            <Form.Item label={t('task.conversation')}>
              <Input
                value={`${groups.find((g) => g.jid === editTask.chat_jid)?.name || editTask.chat_jid} (${editTask.group_folder})`}
                readOnly
                variant="filled"
              />
            </Form.Item>
          ) : (
            <>
              <Form.Item label={t('task.conversation')} name="chat_jid" rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={conversationOptions}
                  onChange={(jid) => {
                    const g = groups.find((g) => g.jid === jid);
                    if (g) form.setFieldsValue({ group_folder: g.folder });
                  }}
                />
              </Form.Item>
              <Form.Item name="group_folder" hidden>
                <Input />
              </Form.Item>
            </>
          )}
          <Form.Item label={t('task.prompt')} name="prompt" rules={[{ required: true }]}>
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item label={t('task.scheduleType')} name="schedule_type" rules={[{ required: true }]}>
            <Select options={[
              { label: t('task.cron'), value: 'cron' },
              { label: t('task.interval'), value: 'interval' },
              { label: t('task.once'), value: 'once' },
            ]} />
          </Form.Item>
          {scheduleType === 'interval' ? (
            <Form.Item label={scheduleValueLabel()}>
              <Space.Compact style={{ width: '100%' }}>
                <InputNumber
                  min={1}
                  value={intervalNum}
                  onChange={(v) => setIntervalNum(v || 1)}
                  style={{ flex: 1 }}
                />
                <Select
                  value={intervalUnit}
                  onChange={setIntervalUnit}
                  style={{ width: 100 }}
                  options={[
                    { label: t('task.unitSeconds'), value: 1000 },
                    { label: t('task.unitMinutes'), value: 60000 },
                    { label: t('task.unitHours'), value: 3600000 },
                    { label: t('task.unitDays'), value: 86400000 },
                  ]}
                />
              </Space.Compact>
            </Form.Item>
          ) : (
            <Form.Item label={scheduleValueLabel()} name="schedule_value" rules={[{ required: true }]}>
              <Input placeholder={schedulePlaceholder(scheduleType || 'cron')} />
            </Form.Item>
          )}
          <Form.Item label={t('task.contextMode')} name="context_mode">
            <Select options={[
              { label: t('task.isolated'), value: 'isolated' },
              { label: t('task.group'), value: 'group' },
            ]} />
          </Form.Item>
          {editTask && (
            <Form.Item label={t('task.status')} name="status">
              <Select options={[
                { label: t('task.active'), value: 'active' },
                { label: t('task.paused'), value: 'paused' },
              ]} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
