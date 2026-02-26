import { useState, useEffect } from 'react';
import { Segmented } from 'antd';
import { RobotOutlined, ClockCircleOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import { useT } from '../i18n';
import { AgentList } from './AgentList';
import { TaskList } from './TaskList';
import { WorkspaceTab } from './WorkspaceTab';

type Tab = 'chats' | 'tasks' | 'workspace';

function tabFromPath(pathname: string): Tab {
  if (pathname.startsWith('/workspace')) return 'workspace';
  if (pathname.startsWith('/task')) return 'tasks';
  return 'chats';
}

interface Props {
  activeJid: string | null;
  activeTaskId: string | null;
  activeFolder: string | null;
  onSelect: (jid: string, name: string) => void;
  onNewChat: () => void;
  onSelectTask: (taskId: string) => void;
  onSelectFolder: (folder: string) => void;
  refreshKey: number;
}

export function Sidebar({ activeJid, activeTaskId, activeFolder, onSelect, onNewChat, onSelectTask, onSelectFolder, refreshKey }: Props) {
  const { t } = useT();
  const location = useLocation();
  const [tab, setTab] = useState<Tab>(() => tabFromPath(location.pathname));

  useEffect(() => {
    setTab(tabFromPath(location.pathname));
  }, [location.pathname]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 8px 0' }}>
        <Segmented
          block
          size="small"
          value={tab}
          onChange={(val) => setTab(val as Tab)}
          options={[
            { label: <span><RobotOutlined /> {t('sidebar.chats')}</span>, value: 'chats' },
            { label: <span><ClockCircleOutlined /> {t('sidebar.tasks')}</span>, value: 'tasks' },
            { label: <span><FolderOpenOutlined /> {t('ws.title')}</span>, value: 'workspace' },
          ]}
        />
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'chats' && (
          <AgentList
            activeJid={activeJid}
            onSelect={onSelect}
            onNewChat={onNewChat}
            onSelectFolder={onSelectFolder}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'tasks' && (
          <TaskList
            refreshKey={refreshKey}
            activeTaskId={activeTaskId}
            onSelectTask={onSelectTask}
            onGoToAgent={(jid, name) => {
              setTab('chats');
              onSelect(jid, name);
            }}
          />
        )}
        {tab === 'workspace' && (
          <WorkspaceTab
            activeFolder={activeFolder}
            onSelectFolder={onSelectFolder}
            onSelectChat={(jid: string, name: string) => {
              setTab('chats');
              onSelect(jid, name);
            }}
          />
        )}
      </div>
    </div>
  );
}
