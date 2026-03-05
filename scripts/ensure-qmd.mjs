#!/usr/bin/env node
/**
 * Ensure bundled QMD is available locally.
 *
 * Behavior:
 * - If bundled @tobilu/qmd is already resolvable and executable: no-op.
 * - Otherwise, install @tobilu/qmd into app dependencies.
 * - Validate by resolving both package metadata + binary shim path.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const QMD_PACKAGE = '@tobilu/qmd';
const QMD_VERSION = '^1.0.7';
const EXE_NAME = process.platform === 'win32' ? 'qmd.cmd' : 'qmd';
const require = createRequire(import.meta.url);

function resolveBundledQmdPath() {
  const shimCwd = join(process.cwd(), 'node_modules', '.bin', EXE_NAME);
  if (existsSync(shimCwd)) return shimCwd;

  try {
    const pkgPath = require.resolve(`${QMD_PACKAGE}/package.json`);
    const pkgDir = dirname(pkgPath);

    // Prefer npm-generated shim (cross-platform), fallback to package bin script.
    const shimPath = join(pkgDir, '..', '..', '.bin', EXE_NAME);
    if (existsSync(shimPath)) return shimPath;

    const packageBin = join(pkgDir, 'qmd');
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

function resolveBundledQmdVersion() {
  try {
    const pkg = require(`${QMD_PACKAGE}/package.json`);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return `qmd ${pkg.version.trim()}`;
    }
  } catch {
    // package not resolvable
  }
  return null;
}

function installBundledQmd() {
  // Install as a direct app dependency so availability is deterministic.
  const install = run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--save',
    `${QMD_PACKAGE}@${QMD_VERSION}`,
  ]);
  return install.status === 0;
}

function main() {
  let binaryPath = resolveBundledQmdPath();
  let version = resolveBundledQmdVersion();

  if (binaryPath && version) {
    console.log(`QMD already available: ${binaryPath}`);
    console.log(`Version: ${version}`);
    return;
  }
  if (binaryPath && !version) {
    console.log(`Found QMD shim path but package metadata could not be resolved: ${binaryPath}`);
  } else {
    console.log('Bundled QMD not found. Installing...');
  }

  if (!installBundledQmd()) {
    console.error('Failed to install bundled QMD via npm.');
    process.exit(1);
  }

  binaryPath = resolveBundledQmdPath();
  version = resolveBundledQmdVersion();
  if (!binaryPath || !version) {
    console.error('Install completed but bundled QMD path could not be resolved.');
    process.exit(1);
  }

  console.log(`Bundled QMD installed: ${binaryPath}`);
  console.log(`Version: ${version}`);
}

main();
