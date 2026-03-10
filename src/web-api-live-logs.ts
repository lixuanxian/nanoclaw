/**
 * Live container log streaming via Server-Sent Events.
 * Spawns `docker logs --follow` for the running container and streams output to the client.
 */
import { spawn } from 'child_process';

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import type { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

export function registerLiveLogRoutes(app: Hono, queue: GroupQueue): void {
  /** SSE stream of live container logs for a folder. */
  app.get('/api/live-logs/:folder', (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    const state = queue.getGroupState(folder);

    if (!state?.containerName) {
      return c.json({ error: 'No running container for this folder' }, 404);
    }

    const containerName = state.containerName;
    logger.debug({ folder, containerName }, 'Starting live log stream');

    return streamSSE(c, async (stream) => {
      let id = 0;
      const proc = spawn(
        CONTAINER_RUNTIME_BIN,
        ['logs', '--follow', '--timestamps', '--tail', '200', containerName],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      const sendLines = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line) {
            stream
              .writeSSE({ data: line, event: 'log', id: String(id++) })
              .catch(() => {});
          }
        }
      };

      proc.stdout?.on('data', sendLines);
      proc.stderr?.on('data', sendLines);

      proc.on('close', (code) => {
        logger.debug({ folder, containerName, code }, 'Live log stream ended');
        stream
          .writeSSE({
            data: String(code ?? 0),
            event: 'done',
            id: String(id++),
          })
          .catch(() => {});
        stream.close();
      });

      proc.on('error', (err) => {
        logger.warn({ folder, err }, 'docker logs process error');
        stream.close();
      });

      stream.onAbort(() => {
        proc.kill();
      });

      // Keep the stream open until the docker logs process exits
      await new Promise<void>((resolve) => {
        proc.on('close', resolve);
        proc.on('error', resolve);
      });
    });
  });

  /** Check if a container is currently running for a folder. */
  app.get('/api/container-status/:folder', (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    const state = queue.getGroupState(folder);
    return c.json({
      running: !!(state?.active && state?.containerName),
      containerName: state?.containerName ?? null,
    });
  });
}
