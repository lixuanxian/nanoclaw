import { useEffect, useState } from 'react';
import { Typography, Spin, Tag, Button } from 'antd';
import { ArrowLeftOutlined, CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined, RobotOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getTaskLogs } from '../api';
import { useT } from '../i18n';
import type { ScheduledTaskInfo, TaskRunLogInfo } from '../types';

const { Text, Title } = Typography;

interface Props {
  taskId: string;
  onBack: () => void;
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'code', 'pre',
      'ul', 'ol', 'li', 'a', 'blockquote', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'strong', 'em', 'del', 'span', 'div',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

export function TaskRunView({ taskId, onBack }: Props) {
  const { t } = useT();
  const [task, setTask] = useState<ScheduledTaskInfo | null>(null);
  const [logs, setLogs] = useState<TaskRunLogInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getTaskLogs(taskId)
      .then((data) => {
        setTask(data.task);
        setLogs(data.logs);
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '16px 0' }}>
      {/* Header */}
      <div style={{ padding: '0 24px 16px', borderBottom: '1px solid var(--ant-color-border)' }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} style={{ marginBottom: 8 }}>
          {t('task.backToChat')}
        </Button>
        {task && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <ClockCircleOutlined />
              <Title level={5} style={{ margin: 0 }}>{t('task.runLogs')}</Title>
            </div>
            <Text type="secondary" style={{ fontSize: 13, display: 'block' }}>{task.prompt}</Text>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Tag color={task.status === 'active' ? 'green' : task.status === 'paused' ? 'orange' : 'default'}>
                {t(`task.${task.status}` as 'task.active')}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {task.schedule_type}: {task.schedule_value}
              </Text>
            </div>
          </div>
        )}
      </div>

      {/* Run log entries */}
      <div style={{ padding: '16px 24px' }}>
        {logs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Text type="secondary">{t('task.noLogs')}</Text>
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              {/* Run metadata line */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                {log.status === 'success'
                  ? <CheckCircleOutlined style={{ color: '#4ade80' }} />
                  : <CloseCircleOutlined style={{ color: '#f87171' }} />}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(log.run_at).toLocaleString()}
                </Text>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {formatDuration(log.duration_ms)}
                </Text>
              </div>
              {/* Result bubble (bot-style) */}
              {(log.result || log.error) && (
                <div className="msg-row msg-row-bot" style={{ marginTop: 4 }}>
                  <div className="msg-avatar msg-avatar-bot">
                    <RobotOutlined />
                  </div>
                  <div className="msg-body">
                    <div
                      className="bubble bubble-bot"
                      style={{ wordBreak: 'break-word' }}
                    >
                      {log.error ? (
                        <Text type="danger">{log.error}</Text>
                      ) : (
                        <div
                          className="msg-markdown"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(log.result || '') }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
