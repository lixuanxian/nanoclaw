import { useEffect, useRef, useState, useCallback } from 'react';

interface UseLiveLogsOptions {
  folder: string | null;
  enabled: boolean;
}

interface UseLiveLogsReturn {
  lines: string[];
  connected: boolean;
  done: boolean;
  clear: () => void;
}

const MAX_LINES = 5000;

export function useLiveLogs({ folder, enabled }: UseLiveLogsOptions): UseLiveLogsReturn {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const clear = useCallback(() => setLines([]), []);

  useEffect(() => {
    if (!folder || !enabled) {
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
      return;
    }

    setDone(false);
    setLines([]);
    setConnected(false);

    const es = new EventSource(`/api/live-logs/${encodeURIComponent(folder)}`);
    esRef.current = es;

    es.addEventListener('log', (e) => {
      setLines((prev) => {
        const next = [...prev, e.data];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });

    es.addEventListener('done', () => {
      setDone(true);
      setConnected(false);
      es.close();
    });

    es.onopen = () => setConnected(true);

    es.onerror = () => {
      setConnected(false);
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [folder, enabled]);

  return { lines, connected, done, clear };
}
