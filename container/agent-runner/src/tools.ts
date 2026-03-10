/**
 * Tool definitions and execution for OpenAI-compatible providers.
 * Implements the same capabilities as Claude Agent SDK's built-in tools
 * using OpenAI function calling format.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

const MAX_OUTPUT = 100_000;

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'bash',
        description:
          'Execute a shell command. Working directory is /workspace/group. Commands run with a 120s timeout by default.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute' },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 120000)',
            },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read the contents of a file. Returns content with line numbers.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            offset: {
              type: 'number',
              description: 'Line number to start from (1-based)',
            },
            limit: { type: 'number', description: 'Number of lines to read' },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          'Write content to a file. Creates the file and parent directories if they do not exist. Overwrites existing content.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['file_path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Edit a file by replacing an exact string match with new content.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file' },
            old_string: {
              type: 'string',
              description: 'Exact string to find (must be unique in the file)',
            },
            new_string: { type: 'string', description: 'Replacement string' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob',
        description: 'Find files matching a glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
            path: {
              type: 'string',
              description: 'Directory to search in (default: /workspace/group)',
            },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents using a regex pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            path: {
              type: 'string',
              description:
                'File or directory to search (default: /workspace/group)',
            },
            glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          'Fetch content from a URL. Returns the text content of the response.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch' },
            timeout: {
              type: 'number',
              description: 'Timeout in ms (default: 30000)',
            },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_message',
        description:
          "Send a message to the user or group immediately while you're still running. Use for progress updates or to send multiple messages. Supports cross-channel messaging via target_channel or target_jid.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message text to send' },
            target_channel: {
              type: 'string',
              description:
                'Channel name to send to (e.g., "dingtalk", "slack", "whatsapp", "telegram"). Resolves to the first registered JID for that channel.',
            },
            target_jid: {
              type: 'string',
              description:
                'Specific JID to send to directly (overrides target_channel). Use list_channels to discover available JIDs.',
            },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_channels',
        description:
          'List all connected messaging channels and their conversation JIDs. Use to discover available channels before sending cross-channel messages.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_task',
        description:
          'Schedule a recurring or one-time task. The task will run as a full agent.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'What the agent should do when the task runs',
            },
            schedule_type: {
              type: 'string',
              enum: ['cron', 'interval', 'once'],
              description: 'Task schedule type',
            },
            schedule_value: {
              type: 'string',
              description:
                'cron expression, interval in ms, or local timestamp (no Z suffix)',
            },
            context_mode: {
              type: 'string',
              enum: ['group', 'isolated'],
              description:
                'group=with chat history, isolated=fresh session (default: group)',
            },
          },
          required: ['prompt', 'schedule_type', 'schedule_value'],
        },
      },
    },
  ];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case 'bash':
      return executeBash(args);
    case 'read_file':
      return executeReadFile(args);
    case 'write_file':
      return executeWriteFile(args);
    case 'edit_file':
      return executeEditFile(args);
    case 'glob':
      return executeGlob(args);
    case 'grep':
      return executeGrep(args);
    case 'web_fetch':
      return executeWebFetch(args);
    case 'send_message':
      return executeSendMessage(args, context);
    case 'list_channels':
      return executeListChannels();
    case 'schedule_task':
      return executeScheduleTask(args, context);
    default:
      return { output: `Unknown tool: ${name}`, isError: true };
  }
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

// --- Tool implementations ---

function executeBash(args: Record<string, unknown>): ToolResult {
  const command = args.command as string;
  const timeout = (args.timeout as number) || 120_000;

  try {
    const result = spawnSync('bash', ['-c', command], {
      cwd: '/workspace/group',
      timeout,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10,
    });

    let output = result.stdout || '';
    if (result.stderr) {
      output += (output ? '\n' : '') + 'STDERR: ' + result.stderr;
    }
    output = output.slice(0, MAX_OUTPUT) || '(no output)';

    return { output, isError: result.status !== 0 };
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeReadFile(args: Record<string, unknown>): ToolResult {
  const filePath = args.file_path as string;
  const offset = (args.offset as number) || 1;
  const limit = args.limit as number | undefined;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const start = Math.max(0, offset - 1);
    const end = limit ? start + limit : lines.length;
    const sliced = lines.slice(start, end);

    const numbered = sliced
      .map((line, i) => `${String(start + i + 1).padStart(6)} ${line}`)
      .join('\n');

    return { output: numbered.slice(0, MAX_OUTPUT) };
  } catch (err) {
    return {
      output: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeWriteFile(args: Record<string, unknown>): ToolResult {
  const filePath = args.file_path as string;
  const content = args.content as string;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return { output: `File written: ${filePath} (${content.length} bytes)` };
  } catch (err) {
    return {
      output: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeEditFile(args: Record<string, unknown>): ToolResult {
  const filePath = args.file_path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const idx = content.indexOf(oldString);

    if (idx === -1) {
      return { output: 'Error: old_string not found in file.', isError: true };
    }

    // Check uniqueness
    const secondIdx = content.indexOf(oldString, idx + 1);
    if (secondIdx !== -1) {
      return {
        output:
          'Error: old_string is not unique in the file. Provide more surrounding context.',
        isError: true,
      };
    }

    const updated = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
    fs.writeFileSync(filePath, updated);
    return { output: `File edited: ${filePath}` };
  } catch (err) {
    return {
      output: `Error editing file: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeGlob(args: Record<string, unknown>): ToolResult {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || '/workspace/group';

  try {
    const result = spawnSync(
      'find',
      [searchPath, '-path', `*${pattern.replace(/\*\*/g, '*')}`, '-type', 'f'],
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024 },
    );

    const output = (result.stdout || '').trim();
    if (!output) return { output: 'No files matched.' };
    return { output: output.slice(0, MAX_OUTPUT) };
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function executeGrep(args: Record<string, unknown>): ToolResult {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || '/workspace/group';
  const globFilter = args.glob as string | undefined;

  try {
    const grepArgs = ['-rn', '--color=never'];
    if (globFilter) {
      grepArgs.push('--include', globFilter);
    }
    grepArgs.push(pattern, searchPath);

    const result = spawnSync('grep', grepArgs, {
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    const output = (result.stdout || '').trim();
    if (!output) return { output: 'No matches found.' };
    return { output: output.slice(0, MAX_OUTPUT) };
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function executeWebFetch(args: Record<string, unknown>): Promise<ToolResult> {
  const url = args.url as string;
  const timeout = (args.timeout as number) || 30_000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    const text = await response.text();
    return {
      output: `HTTP ${response.status}\n\n${text.slice(0, MAX_OUTPUT)}`,
      isError: !response.ok,
    };
  } catch (err) {
    return {
      output: `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

const CHANNELS_FILE = '/workspace/ipc/connected_channels.json';

/** Resolve a channel name to a JID from the channels snapshot. */
function resolveChannelJid(channelName: string): { jid?: string; error?: string } {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) {
      return { error: 'No channel information available.' };
    }
    const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = data.channels?.find((c: any) => c.id === channelName);
    if (!channel) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const available = (data.channels || []).map((c: any) => c.id).join(', ');
      return { error: `Channel "${channelName}" not found. Available: ${available || 'none'}` };
    }
    if (!channel.connected) {
      return { error: `Channel "${channelName}" is not connected.` };
    }
    if (!channel.jids || channel.jids.length === 0) {
      return { error: `No conversations registered for channel "${channelName}".` };
    }
    return { jid: channel.jids[0].jid };
  } catch {
    return { error: 'Failed to read channel info.' };
  }
}

function executeSendMessage(
  args: Record<string, unknown>,
  context: ToolContext,
): ToolResult {
  let targetJid = context.chatJid;

  if (args.target_jid) {
    targetJid = args.target_jid as string;
  } else if (args.target_channel) {
    const resolved = resolveChannelJid(args.target_channel as string);
    if (resolved.error) {
      return { output: resolved.error, isError: true };
    }
    targetJid = resolved.jid!;
  }

  const data = {
    type: 'message',
    chatJid: targetJid,
    text: args.text as string,
    groupFolder: context.groupFolder,
    timestamp: new Date().toISOString(),
  };

  writeIpcFile('/workspace/ipc/messages', data);
  const channelNote = targetJid !== context.chatJid ? ` (to ${targetJid})` : '';
  return { output: `Message sent${channelNote}.` };
}

function executeListChannels(): ToolResult {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) {
      return { output: 'No channel information available yet.' };
    }
    const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels = data.channels || [];
    if (channels.length === 0) {
      return { output: 'No channels registered.' };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatted = channels.map((ch: any) => {
      const status = ch.connected ? 'connected' : 'disconnected';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jids = (ch.jids || []).map((j: any) => `  - ${j.jid} (${j.name})`).join('\n');
      return `- ${ch.displayName} (${ch.id}) [${status}]\n${jids || '  (no conversations)'}`;
    }).join('\n');
    return { output: `Connected channels:\n${formatted}` };
  } catch {
    return { output: 'Failed to read channel info.', isError: true };
  }
}

function executeScheduleTask(
  args: Record<string, unknown>,
  context: ToolContext,
): ToolResult {
  const data = {
    type: 'schedule_task',
    prompt: args.prompt,
    schedule_type: args.schedule_type,
    schedule_value: args.schedule_value,
    context_mode: (args.context_mode as string) || 'group',
    targetJid: context.chatJid,
    createdBy: context.groupFolder,
    timestamp: new Date().toISOString(),
  };

  const filename = writeIpcFile('/workspace/ipc/tasks', data);
  return { output: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` };
}
