#!/usr/bin/env node
/**
 * Copy the root README and LICENSE into every publishable package.
 *
 * npm only picks up a README and a LICENSE that sit *inside* the package
 * directory, so without this every package publishes with a blank page and no
 * license text. The obvious fix is to commit a copy in each of the eight
 * packages, which is the thing this repository's own CLAUDE.md warns about:
 * two files describing the same rules drift apart, and a stale one is worse
 * than none. So the copies are generated at release time and gitignored.
 *
 *   node scripts/prepare-release.mjs           write the copies
 *   node scripts/prepare-release.mjs --clean   remove them again
 *
 * Idempotent, and safe to run on a clean tree: it only ever touches files it
 * generated itself.
 */
import { copyFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const COPIED = ['README.md', 'LICENSE'];

/**
 * Walks `packages/` two levels deep, which is exactly how far the workspace
 * globs in pnpm-workspace.yaml reach (`packages/*` and `packages/detectors/*`).
 */
async function findPackages(dir, depth = 0) {
  if (depth > 2) return [];

  const manifest = join(dir, 'package.json');
  if (await exists(manifest)) return [dir];

  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    found.push(...(await findPackages(join(dir, entry.name), depth + 1)));
  }
  return found;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const clean = process.argv.includes('--clean');
const packages = await findPackages(join(root, 'packages'));

for (const pkg of packages) {
  // A private package is never published, so a README in it would be litter.
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  if (manifest.private === true) continue;

  for (const file of COPIED) {
    const target = join(pkg, file);
    if (clean) {
      await rm(target, { force: true });
    } else {
      await copyFile(join(root, file), target);
    }
  }

  console.log(`${clean ? 'cleaned' : 'prepared'}  ${relative(root, pkg).replaceAll('\\', '/')}`);
}
