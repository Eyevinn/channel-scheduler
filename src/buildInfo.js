// Build identification helper.
//
// Surfaces which build a running instance is, so a deployed container can be
// identified without inferring it from runtime behaviour (issue #41).
//
// Resolution order for the commit sha:
//   1. An env var baked into the image at build time (BUILD_SHA / SOURCE_COMMIT
//      / SOURCE_COMMIT_SHORT / GIT_COMMIT) — this is the path that works in the
//      deployed container, where the .git directory is not shipped.
//   2. A runtime `git rev-parse --short HEAD`, only if a .git dir is present
//      (local dev). The container excludes .git via .dockerignore, so this is a
//      convenience for running from a checkout, never relied on in production.
//   3. "unknown" if neither is available.
//
// The version comes from package.json.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Env var names that may carry the build commit, in priority order. OSC / other
// build systems may inject one of these; a plain Dockerfile ARG->ENV also works.
const COMMIT_ENV_VARS = [
  'BUILD_SHA',
  'SOURCE_COMMIT',
  'SOURCE_COMMIT_SHORT',
  'GIT_COMMIT'
];

function resolveCommitFromEnv() {
  for (const name of COMMIT_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveCommitFromGit() {
  // Only attempt if a .git directory exists at the repo root, otherwise this
  // spawns a failing subprocess on every call in the container.
  const gitDir = path.join(__dirname, '..', '.git');
  if (!fs.existsSync(gitDir)) {
    return null;
  }
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim() || null;
  } catch (err) {
    return null;
  }
}

function resolveVersion() {
  try {
    // eslint-disable-next-line global-require
    const pkg = require('../package.json');
    return pkg.version || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

// Resolve once at module load — the commit and version are fixed for the life
// of the process, so there is no need to recompute on every request.
const commit = resolveCommitFromEnv() || resolveCommitFromGit() || 'unknown';
const version = resolveVersion();

const buildInfo = Object.freeze({ commit, version });

function getBuildInfo() {
  return buildInfo;
}

module.exports = { getBuildInfo, buildInfo };
