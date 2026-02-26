import * as esbuild from 'esbuild';
import { cpSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

const buildOptions: esbuild.BuildOptions = {
  entryPoints: [resolve(__dirname, 'src/main.tsx')],
  bundle: true,
  outdir: resolve(__dirname, 'dist/assets'),
  format: 'esm',
  splitting: true,
  minify: !isWatch,
  sourcemap: isWatch,
  target: 'es2022',
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
    '.css': 'css',
  },
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
  },
  logLevel: 'info',
};

// Copy index.html to dist/
cpSync(resolve(__dirname, 'index.html'), resolve(__dirname, 'dist/index.html'));

// Copy static assets (like favicon and CSS) to dist/assets/
cpSync(resolve(__dirname, '../assets/nanoclaw.ico'), resolve(__dirname, 'dist/favicon.ico'), { recursive: true });

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Build complete.');
}
