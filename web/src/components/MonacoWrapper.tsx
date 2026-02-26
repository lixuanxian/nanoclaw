import { useEffect, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { Spin } from 'antd';

const EXT_TO_LANG: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.json': 'json', '.jsonc': 'json',
  '.md': 'markdown', '.markdown': 'markdown',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.py': 'python',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.xml': 'xml', '.svg': 'xml',
  '.sql': 'sql',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.toml': 'ini',
  '.ini': 'ini', '.conf': 'ini', '.env': 'ini',
  '.csv': 'plaintext', '.log': 'plaintext', '.txt': 'plaintext',
  '.dockerfile': 'dockerfile',
};

export function getMonacoLanguage(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = fileName.slice(dot).toLowerCase();
  // Handle Dockerfile without extension
  if (fileName.toLowerCase() === 'dockerfile') return 'dockerfile';
  return EXT_TO_LANG[ext] || 'plaintext';
}

function getTheme(): string {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs';
}

interface Props {
  value: string;
  language?: string;
  fileName?: string;
  readOnly?: boolean;
  height?: string | number;
  onChange?: (value: string) => void;
}

export function MonacoWrapper({ value, language, fileName, readOnly = false, height = '60vh', onChange }: Props) {
  const [theme, setTheme] = useState(getTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const lang = language || (fileName ? getMonacoLanguage(fileName) : 'plaintext');

  return (
    <Editor
      height={height}
      language={lang}
      value={value}
      theme={theme}
      onChange={(v) => onChange?.(v ?? '')}
      loading={<div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: readOnly ? 'off' : 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        folding: true,
        renderLineHighlight: readOnly ? 'none' : 'line',
        contextmenu: !readOnly,
        domReadOnly: readOnly,
      }}
    />
  );
}
