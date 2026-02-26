import { Button, Tooltip } from 'antd';
import { USFlag, CNFlag } from './Icons';

type Lang = 'system' | 'en' | 'zh-CN';

interface Props {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

function resolveSystemLang(): 'en' | 'zh-CN' {
  return navigator.language.startsWith('zh') ? 'zh-CN' : 'en';
}

export function LanguageToggle({ lang, setLang }: Props) {
  const resolved = lang === 'system' ? resolveSystemLang() : lang;
  const next = resolved === 'en' ? 'zh-CN' : 'en';
  const title = resolved === 'en' ? 'English' : '中文';

  return (
    <Tooltip title={title}>
      <Button
        type="text"
        onClick={() => setLang(next)}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {resolved === 'en' ? <USFlag /> : <CNFlag />}
      </Button>
    </Tooltip>
  );
}