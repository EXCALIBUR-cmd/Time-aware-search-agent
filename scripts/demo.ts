import { spawn } from 'node:child_process';
import { DEMO_NOW } from './seed';

process.env.AGENT_NOW = DEMO_NOW;

const next = require.resolve('next/dist/bin/next');
spawn(process.execPath, [next, 'dev', ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', (code) =>
  process.exit(code ?? 0),
);
