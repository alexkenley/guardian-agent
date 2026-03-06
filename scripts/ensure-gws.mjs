#!/usr/bin/env node
/**
 * Ensure bundled Google Workspace CLI (gws) is available locally.
 *
 * Behavior:
 * - If bundled @googleworkspace/cli is already resolvable and executable: no-op.
 * - Otherwise, install @googleworkspace/cli into app dependencies.
 * - Validate by resolving both package metadata + binary shim path.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const GWS_PACKAGE = '@googleworkspace/cli';
const GWS_VERSION = '^0.7.0';
const EXE_NAME = process.platform === 'win32' ? 'gws.cmd' : 'gws';
const require = createRequire(import.meta.url);

function resolveBundledGwsPath() {
  const shimCwd = join(process.cwd(), 'node_modules', '.bin', EXE_NAME);
  if (existsSync(shimCwd)) return shimCwd;

  try {
    const pkgPath = require.resolve(`${GWS_PACKAGE}/package.json`);
    const pkgDir = dirname(pkgPath);

    // Prefer npm-generated shim (cross-platform), fallback to package bin script.
    const shimPath = join(pkgDir, '..', '..', '.bin', EXE_NAME);
    if (existsSync(shimPath)) return shimPath;

    const packageBin = join(pkgDir, 'gws');
    if (existsSync(packageBin)) return packageBin;
  } catch {
    // package is not installed
  }
  return undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    shell: false,
    ...options,
  });
  return result;
}

function resolveBundledGwsVersion() {
  try {
    const pkg = require(`${GWS_PACKAGE}/package.json`);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return `gws ${pkg.version.trim()}`;
    }
  } catch {
    // package not resolvable
  }
  return null;
}

function installBundledGws() {
  // Install as a direct app dependency so availability is deterministic.
  const install = run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--save',
    `${GWS_PACKAGE}@${GWS_VERSION}`,
  ]);
  return install.status === 0;
}

function main() {
  let binaryPath = resolveBundledGwsPath();
  let version = resolveBundledGwsVersion();

  if (binaryPath && version) {
    console.log(`GWS already available: ${binaryPath}`);
    console.log(`Version: ${version}`);
    return;
  }
  if (binaryPath && !version) {
    console.log(`Found GWS shim path but package metadata could not be resolved: ${binaryPath}`);
  } else {
    console.log('Bundled GWS not found. Installing...');
  }

  if (!installBundledGws()) {
    console.error('Failed to install bundled GWS via npm.');
    process.exit(1);
  }

  binaryPath = resolveBundledGwsPath();
  version = resolveBundledGwsVersion();
  if (!binaryPath || !version) {
    console.error('Install completed but bundled GWS path could not be resolved.');
    process.exit(1);
  }

  console.log(`Bundled GWS installed: ${binaryPath}`);
  console.log(`Version: ${version}`);
}

main();
