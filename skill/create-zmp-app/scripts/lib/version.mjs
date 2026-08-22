import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function installedRef(skillDir) {
  const stamp = path.join(skillDir, 'INSTALLED_VERSION');
  if (!fs.existsSync(stamp)) return null;
  const match = /^ref=(.+)$/m.exec(fs.readFileSync(stamp, 'utf8'));
  return match?.[1]?.trim() || null;
}

function claudePluginVersion(skillDir, packageVersion) {
  // Claude installs marketplace plugins below .../plugins/cache/.../<version>/ and keeps
  // the plugin manifest two levels above this canonical skill folder. Requiring both the
  // cache path and a matching manifest avoids lab/source checkouts being mislabeled.
  const normalized = path.resolve(skillDir).split(path.sep);
  const cacheIndex = normalized.lastIndexOf('cache');
  if (cacheIndex < 1 || normalized[cacheIndex - 1] !== 'plugins') return null;

  const manifest = readJson(path.resolve(skillDir, '..', '..', '.claude-plugin', 'plugin.json'));
  if (manifest?.name !== 'create-zmp-app' || manifest?.version !== packageVersion) return null;
  return manifest.version;
}

export function doctorVersionLine(skillDir) {
  const pkg = readJson(path.join(skillDir, 'package.json'));
  if (!pkg?.version) return 'doctor: ok';

  const ref = installedRef(skillDir);
  if (ref) return `doctor: ok — create-zmp-app v${pkg.version} (${ref})`;

  const pluginVersion = claudePluginVersion(skillDir, pkg.version);
  if (pluginVersion) {
    return `doctor: ok — create-zmp-app v${pkg.version} (claude-plugin v${pluginVersion})`;
  }

  return `doctor: ok — create-zmp-app v${pkg.version} (dev copy)`;
}
