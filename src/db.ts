// Barrel re-export — preserves existing import paths
export { getDb, initDatabase, _initTestDatabase } from './db-init.js';
export { storeMessage, storeMessageDirect, getNewMessages, getMessagesSince, getAllMessagesForChat, getMessagesBefore, countMessagesForChat, getMessagesSinceMultiJid, getAllMessagesForJids, countMessagesForJids, getMessagesBeforeMultiJid } from './db-messages.js';
export { createTask, getTaskById, getTasksForGroup, getAllTasks, updateTask, deleteTask, getDueTasks, updateTaskAfterRun, logTaskRun } from './db-tasks.js';
export {
  storeChatMetadata, updateChatName, getAllChats, getLastGroupSync, setLastGroupSync,
  getRouterState, setRouterState, getSession, setSession, getAllSessions,
  getRegisteredGroup, setRegisteredGroup, getAllRegisteredGroups,
  getJidsByFolder,
  getWebSessions, deleteWebSession,
  getAllConversations, deleteConversation,
} from './db-groups.js';
export type { ChatInfo } from './db-groups.js';
export type { WebSessionInfo } from './db-groups.js';
export type { ConversationInfo } from './db-groups.js';
