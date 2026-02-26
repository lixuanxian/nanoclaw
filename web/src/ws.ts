import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, UploadedFile, WsMessage } from './types';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

interface UseWebSocketOptions {
  sessionId: string | null;
  jid: string | null;
  onHistory: (messages: Message[], olderCount: number) => void;
  onMessage: (message: Message) => void;
  onTyping: (isTyping: boolean) => void;
}

export function useWebSocket({ sessionId, jid, onHistory, onMessage, onTyping }: UseWebSocketOptions) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the active session to prevent stale reconnections
  const activeSessionRef = useRef(sessionId);
  // Stable refs for callbacks to avoid reconnection loops
  const onHistoryRef = useRef(onHistory);
  onHistoryRef.current = onHistory;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

  useEffect(() => {
    activeSessionRef.current = sessionId;
    if (!sessionId) return;

    // Clear any pending reconnection timer from previous session
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent stale reconnection
      wsRef.current.close();
      wsRef.current = null;
    }

    retriesRef.current = 0;

    const connectForSession = () => {
      // Bail out if session changed while waiting for reconnect
      if (activeSessionRef.current !== sessionId) return;

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({ session: sessionId });
      if (jid) params.set('jid', jid);
      const ws = new WebSocket(`${proto}//${location.host}/ws?${params}`);
      wsRef.current = ws;
      setStatus('connecting');

      ws.onopen = () => {
        if (activeSessionRef.current !== sessionId) { ws.close(); return; }
        setStatus('connected');
        retriesRef.current = 0;
      };

      ws.onmessage = (evt) => {
        try {
          const data: WsMessage = JSON.parse(evt.data);
          if (data.type === 'history' && data.messages) {
            const msgs = Array.isArray(data.messages) ? data.messages : [];
            onHistoryRef.current(msgs, data.olderCount ?? 0);
          } else if (data.type === 'message' && data.text) {
            onMessageRef.current({ content: data.text, sender: '', timestamp: new Date().toISOString(), is_bot: true });
          } else if (data.type === 'typing') {
            onTypingRef.current(data.isTyping ?? false);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        // Only reconnect if this session is still active
        if (activeSessionRef.current !== sessionId) return;
        setStatus('reconnecting');
        const delay = Math.min(1000 * 2 ** retriesRef.current, 15000);
        retriesRef.current++;
        timerRef.current = setTimeout(connectForSession, delay);
      };

      ws.onerror = () => ws.close();
    };

    connectForSession();

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent stale reconnection on cleanup
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionId, jid]);

  const send = useCallback((text: string, files?: UploadedFile[], mode?: 'plan' | 'edit', skills?: string[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'message', text, files, mode, skills }));
  }, []);

  return { status, send };
}
