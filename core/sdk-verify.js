/**
 * Sentinel Node Tester — SDK Verification
 *
 * Verifies that the installed copies of `blue-js-sdk` (Blue JS) and
 * `@sentinel-official/sentinel-js-sdk` (TKD) match the published GitHub
 * source at their current tag.
 *
 * Strategy:
 *   1. Read installed version from node_modules/<pkg>/package.json.
 *   2. Read repository.url from the same file (authoritative — npm publishes it).
 *   3. Download the GitHub archive at tag v<version> (tarball, ~MB).
 *   4. For every .js / .ts / .mjs file in the installed package, compute SHA-256
 *      of its contents. Compare against the same-named file in the GitHub tarball.
 *   5. Return per-file pass/fail + overall verdict.
 *
 * Ignored paths:
 *   node_modules/, dist-only files not in source, generated protobuf files,
 *   .map files (sourcemaps), and package-lock.json.
 *
 * Limitations:
 *   - If the GitHub repo uses a build step (TS → dist/), the npm tarball's
 *     compiled output will NOT match the source. We match on source files
 *     that exist verbatim in both (typical for ESM-first SDKs).
 *   - Requires network access to api.github.com + codeload.github.com.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';

// ─── Config ──────────────────────────────────────────────────────────────────

const TRACKED_SDKS = [
  { key: 'blue-js',       pkg: 'blue-js-sdk' },
  { key: 'tkd-js',        pkg: '@sentinel-official/sentinel-js-sdk' },
];

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
// NOTE: 'dist'/'build' are NOT ignored — TS-compiled SDKs (e.g. TKD) ship
// only dist/ on npm. Removing them would render verification vacuous for
// those SDKs. We hash every source-extension file under the package root.
const IGNORE_DIRS = new Set(['node_modules', '.git', '.github']);
const IGNORE_FILES = new Set(['package-lock.json', '.DS_Store']);

/**
 * Normalise text for cross-platform hashing. Strips BOM, CRLF → LF, trailing
 * whitespace preserved. Prevents false-positive mismatches when the SDK is
 * installed on Windows (CRLF) vs checked out on Linux/macOS (LF).
 */
function normaliseText(buf) {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n');
  return Buffer.from(s, 'utf8');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Normalise a repository.url (git+https://... or ssh) → { owner, repo }. */
function parseRepoUrl(url) {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** Resolve the installed package directory from the tester root. */
function installedDir(root, pkg) {
  return path.join(root, 'node_modules', pkg);
}

/** Recursively list source files under a directory, relative to it. */
function listSourceFiles(dir) {
  const out = [];
  (function walk(cur, rel) {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(path.join(cur, entry.name), path.posix.join(rel, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORE_FILES.has(entry.name)) continue;
      if (entry.name.endsWith('.map')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      out.push(path.posix.join(rel, entry.name));
    }
  })(dir, '');
  return out;
}

/** Hash every source file under a directory → { relPath: sha256 }. */
function hashTree(root) {
  const files = listSourceFiles(root);
  const hashes = {};
  for (const rel of files) {
    const full = path.join(root, rel);
    hashes[rel] = sha256(normaliseText(readFileSync(full)));
  }
  return hashes;
}

// ─── Minimal tar (ustar) reader for gunzipped tarballs ──────────────────────
// The GitHub archive is a single gzip'd tarball. We avoid adding a dep (tar)
// by doing a tiny ustar parse for the fields we need.

function readOctal(buf, off, len) {
  const str = buf.slice(off, off + len).toString('ascii').replace(/\0.*$/, '').trim();
  if (!str) return 0;
  return parseInt(str, 8);
}

function readStr(buf, off, len) {
  return buf.slice(off, off + len).toString('utf8').replace(/\0.*$/, '');
}

/** Parse a ustar tarball buffer → iterator of { path, content, type }. */
function* parseTar(buf) {
  let i = 0;
  while (i + 512 <= buf.length) {
    const block = buf.slice(i, i + 512);
    // Zero block = end of archive
    if (block.every(b => b === 0)) return;
    const name = readStr(block, 0, 100);
    const prefix = readStr(block, 345, 155);
    const size = readOctal(block, 124, 12);
    const typeFlag = String.fromCharCode(block[156] || 0);
    const full = prefix ? `${prefix}/${name}` : name;
    i += 512;
    const content = buf.slice(i, i + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    i += paddedSize;
    if (!full || full === '\0') continue;
    yield { path: full, content, type: typeFlag };
  }
}

/**
 * Download + decompress GitHub tag tarball → { [relPath]: Buffer, source, ref }.
 * `ref` tracks whether we hit an actual tag vs had to fall back to a branch.
 */
async function fetchGithubTarball(owner, repo, tag) {
  const attempts = [
    { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/${tag}`,  ref: 'tag',    exact: true  },
    { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/v${tag}`, ref: 'tag',    exact: true  },
    { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${tag}`, ref: 'branch', exact: false },
    { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/main`,   ref: 'main',   exact: false },
    { url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/master`, ref: 'master', exact: false },
  ];

  let resp, usedUrl, usedRef, exactRef = false;
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
      if (r.ok) { resp = r; usedUrl = a.url; usedRef = a.ref; exactRef = a.exact; break; }
    } catch { }
  }
  if (!resp) throw new Error(`Could not download tarball for ${owner}/${repo}@${tag}`);

  // Gunzip + collect into one buffer
  const arr = new Uint8Array(await resp.arrayBuffer());
  const gunzip = createGunzip();
  const chunks = [];
  const nodeStream = Readable.from([Buffer.from(arr)]);
  await pipeline(nodeStream, gunzip, async function* (src) {
    for await (const chunk of src) chunks.push(chunk);
  });
  const tarBuf = Buffer.concat(chunks);

  // Parse tar. GitHub prefixes every entry with `<repo>-<sha>/`; strip that.
  const out = {};
  let stripPrefix = null;
  for (const entry of parseTar(tarBuf)) {
    if (entry.type && entry.type !== '0' && entry.type !== '\0') continue;
    if (!stripPrefix) {
      const slash = entry.path.indexOf('/');
      if (slash !== -1) stripPrefix = entry.path.slice(0, slash + 1);
    }
    let rel = entry.path;
    if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
    if (!rel) continue;
    out[rel] = entry.content;
  }
  return { files: out, source: usedUrl, ref: usedRef, exactRef };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Return installed versions of all tracked SDKs. Fast — no network.
 * @param {string} [rootDir]
 * @returns {{ [key: string]: { pkg, version, repository } }}
 */
export function getInstalledVersions(rootDir) {
  const root = rootDir || process.cwd();
  const out = {};
  for (const { key, pkg } of TRACKED_SDKS) {
    const pkgDir = installedDir(root, pkg);
    const pkgJson = path.join(pkgDir, 'package.json');
    if (!existsSync(pkgJson)) {
      out[key] = { pkg, version: null, repository: null, installed: false };
      continue;
    }
    const data = JSON.parse(readFileSync(pkgJson, 'utf8'));
    out[key] = {
      pkg,
      version: data.version || null,
      repository: data.repository?.url || null,
      installed: true,
    };
  }
  return out;
}

/**
 * Verify one SDK against its GitHub tag. Downloads + hashes.
 * @param {string} key    'blue-js' | 'tkd-js'
 * @param {string} [rootDir]
 * @returns {Promise<{ ok, pkg, version, repository, matched, mismatched, missingOnGithub, missingLocal, sourceUrl }>}
 */
export async function verifySdk(key, rootDir) {
  const root = rootDir || process.cwd();
  const sdk = TRACKED_SDKS.find(s => s.key === key);
  if (!sdk) throw new Error(`Unknown SDK key: ${key}`);

  const pkgDir = installedDir(root, sdk.pkg);
  if (!existsSync(pkgDir)) {
    return { ok: false, pkg: sdk.pkg, reason: 'not installed' };
  }
  const info = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const version = info.version;
  const repoUrl = info.repository?.url || null;
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    return { ok: false, pkg: sdk.pkg, version, reason: 'no github repository in package.json' };
  }

  const { files: ghFiles, source: sourceUrl, ref, exactRef } = await fetchGithubTarball(parsed.owner, parsed.repo, version);

  const localHashes = hashTree(pkgDir);

  const matched = [];
  const mismatched = [];
  const missingOnGithub = [];
  for (const [rel, localHash] of Object.entries(localHashes)) {
    const gh = ghFiles[rel];
    if (!gh) { missingOnGithub.push(rel); continue; }
    const ghHash = sha256(normaliseText(gh));
    if (ghHash === localHash) matched.push(rel);
    else mismatched.push({ file: rel, localHash, githubHash: ghHash });
  }

  const missingLocal = [];
  for (const rel of Object.keys(ghFiles)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    if (IGNORE_FILES.has(path.basename(rel))) continue;
    if (rel.split('/').some(p => IGNORE_DIRS.has(p))) continue;
    if (!(rel in localHashes)) missingLocal.push(rel);
  }

  const ok = mismatched.length === 0 && missingOnGithub.length === 0;
  const warning = exactRef
    ? null
    : `No GitHub tag matches v${version}; compared against ${ref}. Mismatches may reflect upstream drift since publish, not tampering.`;

  return {
    ok,
    pkg: sdk.pkg,
    version,
    repository: `https://github.com/${parsed.owner}/${parsed.repo}`,
    tag: `v${version}`,
    sourceUrl,
    ref,
    exactRef,
    warning,
    counts: {
      local: Object.keys(localHashes).length,
      github: Object.keys(ghFiles).filter(r => SOURCE_EXTENSIONS.has(path.extname(r).toLowerCase())).length,
      matched: matched.length,
      mismatched: mismatched.length,
      missingOnGithub: missingOnGithub.length,
      missingLocal: missingLocal.length,
    },
    mismatched,
    missingOnGithub,
    missingLocal,
  };
}

/** Verify every tracked SDK in sequence. */
export async function verifyAllSdks(rootDir) {
  const results = {};
  for (const { key } of TRACKED_SDKS) {
    try {
      results[key] = await verifySdk(key, rootDir);
    } catch (err) {
      results[key] = { ok: false, error: err.message };
    }
  }
  return results;
}
