import { Button, Tooltip } from 'antd';
import { SunOutlined, MoonOutlined } from '@ant-design/icons';
import { saveTheme } from '../theme';
import { useT } from '../i18n';
import type { ThemeMode } from '../types';

interface Props {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

const cycle: ThemeMode[] = ['dark', 'light'];

function resolveMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

const icons: Record<ThemeMode, React.ReactNode> = {
  system: <MoonOutlined />,
  dark: <MoonOutlined />,
  light: <SunOutlined />,
};

export function ThemeToggle({ themeMode, setThemeMode }: Props) {
  const { t } = useT();
  const displayMode = resolveMode(themeMode);

  const labels: Record<ThemeMode, string> = {
    system: t('user.themeSystem'),
    dark: t('user.themeDark'),
    light: t('user.themeLight'),
  };

  const next = () => {
    const idx = cycle.indexOf(displayMode);
    const nextMode = cycle[(idx + 1) % cycle.length];
    saveTheme(nextMode);
    setThemeMode(nextMode);
  };

  return (
    <Tooltip title={labels[displayMode]}>
      <Button type="text" icon={icons[displayMode]} onClick={next} />
    </Tooltip>
  );
}
