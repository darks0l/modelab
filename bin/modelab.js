#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, '..', 'dist', 'cli.js');

const child = spawn('node', [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', code => process.exit(code ?? 0));
