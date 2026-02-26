import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import type { ThemeMode } from './types';

function isDarkMode(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const commonTokens = {
  colorPrimary: '#1d4ed8',
  borderRadius: 8,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

const darkPalette = {
  colorPrimary: '#60a5fa',
  colorBgContainer: '#141a23',
  colorBgElevated: '#1b2430',
  colorBgLayout: '#0b0f14',
  colorBorder: '#4c5c72',
  colorBorderSecondary: '#64748b',
  colorText: '#e6edf3',
  colorTextSecondary: '#a9b7c6',
};

const lightPalette = {
  colorPrimary: '#1d4ed8',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#f8fafc',
  colorBgLayout: '#eef3f8',
  colorBorder: '#b9c4d3',
  colorBorderSecondary: '#d1d9e5',
  colorText: '#111827',
  colorTextSecondary: '#4b5563',
};

export function getThemeConfig(mode: ThemeMode): ThemeConfig {
  const dark = isDarkMode(mode);
  const palette = dark ? darkPalette : lightPalette;

  return {
    cssVar: {},
    algorithm: [dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm],
    token: {
      ...commonTokens,
      ...palette,
    },
    components: {
      Layout: {
        siderBg: palette.colorBgContainer,
        headerBg: palette.colorBgContainer,
        bodyBg: palette.colorBgLayout,
      },
      Card: {
        colorBorderSecondary: palette.colorBorderSecondary,
      },
      Menu: {
        itemBg: 'transparent',
      },
    },
  };
}

export function applyThemeAttribute(mode: ThemeMode) {
  const resolved = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function getSavedTheme(): ThemeMode {
  return (localStorage.getItem('nanoclaw_theme') as ThemeMode) || 'system';
}

export function saveTheme(mode: ThemeMode) {
  localStorage.setItem('nanoclaw_theme', mode);
  applyThemeAttribute(mode);
}
