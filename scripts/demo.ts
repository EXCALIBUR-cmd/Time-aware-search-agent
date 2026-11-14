import { spawn } from 'node:child_process';
import { DEMO_NOW } from './seed';

process.env.AGENT_NOW = DEMO_NOW;
process.env.AGENT_DEMO = '1';

const nextCliRunByThisNodeWithoutAShell = require.resolve('next/dist/bin/next');
spawn(process.execPath, [nextCliRunByThisNodeWithoutAShell, 'dev', ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', (code) =>
  process.exit(code ?? 0),
);
