import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import { I18nProvider } from './i18n';
import { getThemeConfig, getSavedTheme, applyThemeAttribute } from './theme';
import type { ThemeMode } from './types';
import { ChatPage } from './pages/Chat';
import { SettingsPage } from './pages/Settings';
import { LoginPage } from './pages/Login';

export function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getSavedTheme);

  useEffect(() => {
    applyThemeAttribute(themeMode);
  }, [themeMode]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (themeMode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeAttribute('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeMode]);

  return (
    <I18nProvider>
      <ConfigProvider theme={getThemeConfig(themeMode)}>
        <AntApp>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/settings/:tab?" element={<SettingsPage themeMode={themeMode} setThemeMode={setThemeMode} />} />
              <Route path="/agent-chat/:jid?" element={<ChatPage themeMode={themeMode} setThemeMode={setThemeMode} />} />
              <Route path="/task/:taskId?" element={<ChatPage themeMode={themeMode} setThemeMode={setThemeMode} />} />
              <Route path="/workspace/:folder?" element={<ChatPage themeMode={themeMode} setThemeMode={setThemeMode} />} />
              <Route path="/" element={<ChatPage themeMode={themeMode} setThemeMode={setThemeMode} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </AntApp>
      </ConfigProvider>
    </I18nProvider>
  );
}
