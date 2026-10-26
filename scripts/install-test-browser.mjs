import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Optional test dependency only. This cache is never packaged with the extension.
const result = spawnSync(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium', '--no-shell'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || resolve('.cache-browser') },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
