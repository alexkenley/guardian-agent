import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const options = {
    repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    requireStage: false,
    stageRoot: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root') {
      options.repoRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--stage-root') {
      options.stageRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--require-stage') {
      options.requireStage = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateOverrideEntries(overrides, errors, trail = []) {
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const currentTrail = [...trail, key];
    if (typeof value === 'string') {
      if (!EXACT_VERSION_PATTERN.test(value)) {
        errors.push(`overrides.${currentTrail.join('.')} must be pinned to an exact version, found "${value}".`);
      }
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      validateOverrideEntries(value, errors, currentTrail);
      continue;
    }

    errors.push(`overrides.${currentTrail.join('.')} must be a pinned version string or nested override map.`);
  }
}

function validateRootManifest(repoRoot, errors) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageLockPath = path.join(repoRoot, 'package-lock.json');
  const packageJson = readJson(packageJsonPath);
  const packageLock = readJson(packageLockPath);
  const lockRoot = packageLock.packages?.[''];

  if (!lockRoot) {
    errors.push(`Root package-lock entry is missing in ${packageLockPath}.`);
    return;
  }

  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const manifestEntries = packageJson[section] ?? {};
    const lockEntries = lockRoot[section] ?? {};

    for (const [name, manifestVersion] of Object.entries(manifestEntries)) {
      if (!EXACT_VERSION_PATTERN.test(manifestVersion)) {
        errors.push(`${section}.${name} must be pinned to an exact version, found "${manifestVersion}".`);
      }

      const lockManifestVersion = lockEntries[name];
      if (lockManifestVersion !== manifestVersion) {
        errors.push(
          `${section}.${name} does not match the root lockfile entry (${manifestVersion} vs ${lockManifestVersion ?? 'missing'}).`,
        );
      }

      const installedVersion = packageLock.packages?.[`node_modules/${name}`]?.version;
      if (!installedVersion) {
        errors.push(`${section}.${name} is missing a resolved package entry in package-lock.json.`);
        continue;
      }

      if (installedVersion !== manifestVersion) {
        errors.push(
          `${section}.${name} does not match the reviewed resolved version (${manifestVersion} vs ${installedVersion}).`,
        );
      }
    }
  }

  validateOverrideEntries(packageJson.overrides, errors);
}

function validateStagedManifest(repoRoot, stageRoot, requireStage, errors) {
  if (!stageRoot) {
    return;
  }

  const rootPackageJsonPath = path.join(repoRoot, 'package.json');
  const rootPackageLockPath = path.join(repoRoot, 'package-lock.json');
  const stagePackageJsonPath = path.join(stageRoot, 'package.json');
  const stagePackageLockPath = path.join(stageRoot, 'package-lock.json');
  const stagePackageJsonExists = fs.existsSync(stagePackageJsonPath);
  const stagePackageLockExists = fs.existsSync(stagePackageLockPath);

  if (!stagePackageJsonExists && !stagePackageLockExists) {
    if (requireStage) {
      errors.push(`Required staged manifests were not found under ${stageRoot}.`);
    }
    return;
  }

  if (!stagePackageJsonExists || !stagePackageLockExists) {
    errors.push(`Staged manifests under ${stageRoot} are incomplete; both package.json and package-lock.json are required.`);
    return;
  }

  const comparisons = [
    [rootPackageJsonPath, stagePackageJsonPath],
    [rootPackageLockPath, stagePackageLockPath],
  ];

  for (const [rootPath, stagePath] of comparisons) {
    const rootContent = fs.readFileSync(rootPath);
    const stageContent = fs.readFileSync(stagePath);
    if (!rootContent.equals(stageContent)) {
      errors.push(
        `Generated staged manifest ${stagePath} no longer matches ${rootPath}. Re-run the supported Windows packaging flow to regenerate it.`,
      );
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const errors = [];

  validateRootManifest(options.repoRoot, errors);
  validateStagedManifest(options.repoRoot, options.stageRoot, options.requireStage, errors);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ERROR: ${error}`);
    }
    process.exit(1);
  }

  const stageStatus = options.stageRoot
    ? `; staged manifests validated at ${options.stageRoot}`
    : '';
  console.log(`Dependency contract validation passed for ${options.repoRoot}${stageStatus}.`);
}

main();
