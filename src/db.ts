// Barrel re-export — preserves existing import paths
export { getDb, initDatabase, rebuildFtsIndex, _initTestDatabase } from './db-init.js';
export { storeMessage, storeMessageDirect, getNewMessages, getMessagesSince, getAllMessagesForChat, getMessagesBefore, countMessagesForChat, getMessagesSinceMultiJid, getAllMessagesForJids, countMessagesForJids, getMessagesBeforeMultiJid, searchMessages, deleteMessageById, updateMessageContent, deleteMessagesAfter, getMessageTimestamp } from './db-messages.js';
export type { SearchResult } from './db-messages.js';
export { createTask, getTaskById, getTasksForGroup, getAllTasks, updateTask, deleteTask, getDueTasks, updateTaskAfterRun, logTaskRun, getTaskRunLogs } from './db-tasks.js';
export {
  storeChatMetadata, updateChatName, getAllChats, getLastGroupSync, setLastGroupSync,
  getRouterState, setRouterState, getSession, setSession, getAllSessions,
  getRegisteredGroup, setRegisteredGroup, getAllRegisteredGroups,
  getJidsByFolder,
  getWebSessions, deleteWebSession,
  getAllConversations, deleteConversation,
  getLastRead, setLastRead, countUnreadForJids, getAllConversationsWithUnread,
} from './db-groups.js';
export type { ChatInfo } from './db-groups.js';
export type { WebSessionInfo } from './db-groups.js';
export type { ConversationInfo } from './db-groups.js';
