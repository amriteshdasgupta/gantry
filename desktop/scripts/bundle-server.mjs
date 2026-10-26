// Copies the static assets next to Next's standalone server, which leaves them out.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.next', 'standalone');

// A tracing root can nest the application by its absolute worktree path.
// Find that generated app root without depending on the checkout depth.
function findAppOutput(directory) {
  if (fs.existsSync(path.join(directory, 'server.js'))) return directory;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.next') continue;
    const found = findAppOutput(path.join(directory, entry.name));
    if (found) return found;
  }

  return null;
}

const appOutput = findAppOutput(out);
if (appOutput && appOutput !== out) {
  fs.cpSync(appOutput, out, { recursive: true });
  fs.rmSync(appOutput, { recursive: true });
}

// Flattening the monorepo output moves targets of Next's external-module aliases.
// Rewrite them relative to the shipped tree so installation never depends on
// the build machine's absolute paths.
function relocateLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
      const relocated = target.startsWith(appOutput + path.sep) ? path.join(out, path.relative(appOutput, target)) : target;
      if (relocated.startsWith(out + path.sep)) {
        fs.unlinkSync(file);
        fs.symlinkSync(path.relative(path.dirname(file), relocated), file);
        if (!fs.existsSync(file)) throw new Error(`Broken standalone dependency: ${file}`);
      }
    } else if (entry.isDirectory()) relocateLinks(file);
  }
}
relocateLinks(out);

if (!appOutput || !fs.existsSync(path.join(out, 'server.js'))) {
  console.error('No standalone build found. Run `next build` with output: "standalone" first.');
  process.exit(1);
}
fs.cpSync(path.join(root, '.next', 'static'), path.join(out, '.next', 'static'), { recursive: true });
if (fs.existsSync(path.join(root, 'public'))) fs.cpSync(path.join(root, 'public'), path.join(out, 'public'), { recursive: true });
console.log('Server bundle ready at', path.relative(root, out));
