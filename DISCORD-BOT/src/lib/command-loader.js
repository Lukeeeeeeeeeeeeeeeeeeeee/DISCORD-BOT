const fs = require('fs');
const path = require('path');

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function shouldIgnoreCommandModule(fullPath) {
  const normalized = normalizeRelativePath(fullPath);
  if (normalized.includes('/recruiter-handlers/')) return true;

  const base = path.basename(fullPath).toLowerCase();
  if (base === 'recruitment_report.js') return true;
  if (base.endsWith('-helpers.js')) return true;
  if (base === 'verify.js') return true;
  return false;
}

function readThinProxyTarget(fullPath, commandsPath) {
  let source = '';
  try {
    source = fs.readFileSync(fullPath, 'utf8');
  } catch (_error) {
    return null;
  }

  // Handle BOM from legacy editors before parsing proxy exports.
  const trimmed = source.replace(/^\uFEFF/, '').trim();
  const match = trimmed.match(
    /^(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*module\.exports\s*=\s*require\((['"])([^'"]+)\1\)\s*;?\s*$/
  );
  if (!match) return null;

  const target = match[2];
  if (!target || !target.startsWith('.')) return null;

  const resolvedTarget = path.resolve(path.dirname(fullPath), target);
  const absoluteTarget = path.extname(resolvedTarget) ? resolvedTarget : `${resolvedTarget}.js`;
  if (!fs.existsSync(absoluteTarget)) return null;

  const relativeTarget = path.relative(commandsPath, absoluteTarget);
  if (!relativeTarget || relativeTarget.startsWith('..')) return null;
  return {
    absoluteTarget,
    relativeTarget: normalizeRelativePath(relativeTarget)
  };
}

function collectCommandFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCommandFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }
  return out;
}

function getFilePriority(fullPath, commandsPath) {
  const rel = normalizeRelativePath(path.relative(commandsPath, fullPath));
  if (rel.startsWith('recruiting/')) return 0;
  return 1;
}

function loadCommandsIntoCollection({
  commandsPath,
  collection,
  onLoad = null,
  onWarn = null,
  onInfo = null
} = {}) {
  if (!commandsPath) {
    throw new Error('commandsPath is required');
  }
  if (!collection || typeof collection.set !== 'function') {
    throw new Error('collection with set() is required');
  }

  const commandSourceByName = new Map();
  const loadErrors = [];
  const skippedProxyModules = [];
  const invalidModules = [];

  const files = collectCommandFiles(commandsPath)
    .sort((a, b) => {
      const pa = getFilePriority(a, commandsPath);
      const pb = getFilePriority(b, commandsPath);
      if (pa !== pb) return pa - pb;

      const ra = normalizeRelativePath(path.relative(commandsPath, a));
      const rb = normalizeRelativePath(path.relative(commandsPath, b));
      return ra.localeCompare(rb);
    });

  for (const fullPath of files) {
    if (shouldIgnoreCommandModule(fullPath)) continue;

    const relPath = normalizeRelativePath(path.relative(commandsPath, fullPath));
    const proxyTarget = readThinProxyTarget(fullPath, commandsPath);
    if (proxyTarget) {
      skippedProxyModules.push({
        file: relPath,
        target: proxyTarget.relativeTarget
      });
      const shimMessage = `Skipping compatibility command shim: ${relPath} -> ${proxyTarget.relativeTarget}`;
      if (typeof onInfo === 'function') {
        onInfo(shimMessage);
      } else if (typeof onWarn === 'function') {
        onWarn(shimMessage);
      }
      continue;
    }

    try {
      const cmd = require(fullPath);
      if (!(cmd && cmd.data && cmd.data.name && typeof cmd.execute === 'function')) {
        invalidModules.push(relPath);
        if (typeof onWarn === 'function') {
          onWarn(`Skipping invalid command module: ${relPath}`);
        }
        continue;
      }

      const existingPath = commandSourceByName.get(cmd.data.name);
      if (existingPath) {
        throw new Error(`Duplicate command "${cmd.data.name}" from "${relPath}" and "${existingPath}"`);
      }

      commandSourceByName.set(cmd.data.name, relPath);
      collection.set(cmd.data.name, cmd);
      if (typeof onLoad === 'function') {
        onLoad({ commandName: cmd.data.name, relPath, command: cmd });
      }
    } catch (error) {
      loadErrors.push({ file: relPath, error });
    }
  }

  return {
    commandSourceByName,
    loadErrors,
    skippedProxyModules,
    invalidModules
  };
}

module.exports = {
  loadCommandsIntoCollection,
  shouldIgnoreCommandModule,
  readThinProxyTarget,
  normalizeRelativePath
};
