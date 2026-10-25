#!/usr/bin/env node
// Rebuild and restart the locally installed Apple Silicon desktop app.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = '/Applications/Gantry.app';
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });

try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('desktop:restart currently supports Apple Silicon macOS installs.');
  }

  console.log('Building the Gantry runtime…');
  run('npm', ['run', 'build']);

  if (existsSync(app)) {
    const isRunning = () =>
      execFileSync('osascript', ['-e', `application "${app}" is running`], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim() === 'true';

    if (isRunning()) {
      console.log('Quitting Gantry…');
      execFileSync('osascript', ['-e', `tell application "${app}" to quit`], { timeout: 30000 });
      const deadline = Date.now() + 30000;
      while (isRunning()) {
        if (Date.now() >= deadline) throw new Error('Gantry did not quit. Quit it manually and retry.');
        await delay(500);
      }
    }
  }

  console.log('Building and installing the desktop app…');
  run('npm', ['run', 'app:install', '--prefix', 'desktop']);
  run('open', [app]);
  console.log('Gantry restarted with the updated code.');
} catch (error) {
  console.error(`Desktop restart failed: ${error.message}`);
  process.exitCode = 1;
}
