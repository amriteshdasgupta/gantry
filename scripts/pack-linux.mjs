#!/usr/bin/env node
// Builds a self-contained Linux x64 release of the `gantry` CLI: bundled Node
// runtime + app + production deps + a launcher. Target machines need nothing
// installed (glibc >= 2.28, i.e. RHEL8+, Debian, Ubuntu, Arch — all covered).
//
//   npm run release:linux
//   -> dist/gantry-linux-x64.tar.gz  (+ .sha256)
//
// Install on the target:
//   tar xzf gantry-linux-x64.tar.gz
//   ln -s "$PWD/gantry-linux-x64/gantry" ~/.local/bin/gantry
//   gantry serve
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'dist');
const stageName = 'gantry-linux-x64';
const stage = path.join(outDir, stageName);
const appDir = path.join(stage, 'app');

// Bundle the same Node major we build with, so runtime === dev. Overridable.
const nodeVersion = process.env.GANTRY_NODE_VERSION ?? process.versions.node;

async function copyTracked(globs) {
  const { stdout } = await run('git', ['ls-files', ...globs], { cwd: root });
  for (const file of stdout.split('\n').filter(Boolean)) {
    const target = path.join(appDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
  }
}

async function overlay(rel) {
  const src = path.join(root, rel);
  if (await fs.stat(src).then((s) => s.isDirectory(), () => false)) {
    await fs.cp(src, path.join(appDir, rel), { recursive: true });
  }
}

async function bundleNode() {
  const tarName = `node-v${nodeVersion}-linux-x64.tar.xz`;
  const url = `https://nodejs.org/dist/v${nodeVersion}/${tarName}`;
  const cache = path.join(outDir, tarName);
  if (!(await fs.stat(cache).then(() => true, () => false))) {
    console.log(`Downloading ${url}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Node download failed: ${res.status} ${url}`);
    await pipeline(res.body, createWriteStream(cache));
  }
  // Extract just the binary; that's all the runtime needs (no npm).
  const binRel = `node-v${nodeVersion}-linux-x64/bin/node`;
  await run('tar', ['xJf', cache, '-C', stage, '--strip-components=2', binRel]);
}

console.log('Building…');
await run('npm', ['run', 'build'], { cwd: root });

console.log('Staging…');
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(appDir, { recursive: true });
await copyTracked(['package.json', 'package-lock.json', 'packages']);
await overlay('packages/ui/dist'); // build output, not git-tracked
await overlay('packages/server/runners'); // ensure present even if generated

console.log('Installing production dependencies…');
// Recreates external prod deps + relative @gantry/* workspace symlinks, which
// survive tar and resolve the same way inside the extracted tree.
await run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appDir });

console.log('Bundling Node runtime…');
await bundleNode();

const launcher = `#!/bin/sh
# Self-contained gantry launcher: bundled Node + app, no system deps.
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
DIR="$(cd "$(dirname "$SELF")" && pwd)"
export GANTRY_UI_DIR="\${GANTRY_UI_DIR:-$DIR/app/packages/ui/dist}"
exec "$DIR/node" "$DIR/app/packages/cli/bin/gantry.js" "$@"
`;
await fs.writeFile(path.join(stage, 'gantry'), launcher, { mode: 0o755 });

console.log('Packing…');
const archive = `${stageName}.tar.gz`;
await run('tar', ['czf', archive, stageName], { cwd: outDir });
const bytes = await fs.readFile(path.join(outDir, archive));
const sha = createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(path.join(outDir, `${archive}.sha256`), `${sha}  ${archive}\n`);

console.log(`\nCreated dist/${archive} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
console.log(`SHA-256: ${sha}`);
console.log('\nInstall on any Linux x64 box (glibc >= 2.28):');
console.log(`  tar xzf ${archive}`);
console.log(`  ln -s "$PWD/${stageName}/gantry" ~/.local/bin/gantry`);
console.log('  gantry serve');
