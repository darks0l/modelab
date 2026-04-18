#!/usr/bin/env node
// Prepend shebang to dist/cli.js for npm bin compatibility
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, '..', 'dist', 'cli.js');

const content = readFileSync(cli, 'utf8');
if (!content.startsWith('#!')) {
  writeFileSync(cli, '#!/usr/bin/env node\n' + content);
  console.log('Shebang added to dist/cli.js');
}
