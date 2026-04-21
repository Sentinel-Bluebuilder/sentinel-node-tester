// ─── V2Ray Postinstall Script ───
// Downloads the correct V2Ray binary for the current platform.
// Uses only Node.js built-ins (https, fs, path, child_process).
// Skips if bin/v2ray(.exe) already exists unless --force is passed.

import { createWriteStream, existsSync, mkdirSync, chmodSync, unlinkSync, readdirSync, copyFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const BIN_DIR = join(PROJECT_ROOT, 'bin');

const V2RAY_VERSION = 'v5.47.0';
const BASE_URL = `https://github.com/v2fly/v2ray-core/releases/download/${V2RAY_VERSION}`;

const PLATFORM_MAP = {
  'win32-x64': 'v2ray-windows-64.zip',
  'darwin-x64': 'v2ray-macos-64.zip',
  'darwin-arm64': 'v2ray-macos-arm64-v8a.zip',
  'linux-x64': 'v2ray-linux-64.zip',
  'linux-arm64': 'v2ray-linux-arm64-v8a.zip',
};

const IS_WINDOWS = process.platform === 'win32';
const BINARY_NAME = IS_WINDOWS ? 'v2ray.exe' : 'v2ray';
const BINARY_PATH = join(BIN_DIR, BINARY_NAME);

const EXTRACT_FILES = [BINARY_NAME, 'geoip.dat', 'geosite.dat'];

const forceFlag = process.argv.includes('--force');

// ─── Helpers ───

function log(msg) {
  console.log(`[postinstall] ${msg}`);
}

function follow(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'sentinel-node-tester' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        follow(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      resolve(res);
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    log(`Downloading ${url}`);
    follow(url).then((res) => {
      const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
      let downloaded = 0;
      let lastPercent = -1;

      const file = createWriteStream(dest);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalBytes > 0) {
          const pct = Math.floor((downloaded / totalBytes) * 100);
          if (pct !== lastPercent && pct % 10 === 0) {
            log(`  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
            lastPercent = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
      file.on('error', (err) => {
        file.close();
        unlinkSync(dest);
        reject(err);
      });
    }).catch(reject);
  });
}

function extractZip(zipPath, destDir) {
  const tmpDir = join(destDir, '_v2ray_extract_tmp');
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  mkdirSync(tmpDir, { recursive: true });

  log('Extracting archive...');

  if (IS_WINDOWS) {
    // Use PowerShell Expand-Archive on Windows (built-in, no extra install needed)
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`,
      { stdio: 'pipe' },
    );
  } else {
    // Check unzip is available before invoking
    const whichResult = spawnSync('which', ['unzip'], { encoding: 'utf8' });
    if (whichResult.status !== 0) {
      const installHint = process.platform === 'darwin'
        ? 'brew install unzip'
        : 'apt-get install unzip  (or equivalent for your distro)';
      log(`ERROR: 'unzip' not found. Install it with: ${installHint}`);
      log('V2Ray setup skipped. App will run in limited mode (WireGuard-only nodes).');
      rmSync(tmpDir, { recursive: true, force: true });
      if (existsSync(zipPath)) unlinkSync(zipPath);
      process.exit(0);
    }
    // Use unzip on macOS/Linux
    execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
  }

  // Copy desired files from extracted dir to bin/
  for (const fileName of EXTRACT_FILES) {
    const src = findFile(tmpDir, fileName);
    if (src) {
      const dest = join(destDir, fileName);
      copyFileSync(src, dest);
      log(`  Extracted ${fileName}`);
    } else {
      log(`  WARNING: ${fileName} not found in archive`);
    }
  }

  // Clean up
  rmSync(tmpDir, { recursive: true, force: true });
}

function findFile(dir, name) {
  // Search recursively for a file by name — archives may nest in a subdirectory
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    } else if (entry.name === name) {
      return fullPath;
    }
  }
  return null;
}

// ─── Main ───

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const asset = PLATFORM_MAP[key];

  if (!asset) {
    log(`WARNING: V2Ray binary not available for ${key}. App will run in limited mode (WireGuard-only nodes).`);
    log(`Supported platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`);
    process.exit(0);
  }

  log(`Platform: ${key} -> ${asset}`);
  log(`V2Ray version: ${V2RAY_VERSION}`);

  // Check if binary already exists
  if (existsSync(BINARY_PATH) && !forceFlag) {
    log(`${BINARY_NAME} already exists at ${BINARY_PATH}`);
    log('Skipping download. Use --force to re-download.');
    return;
  }

  if (forceFlag && existsSync(BINARY_PATH)) {
    log('--force passed, re-downloading...');
  }

  // Ensure bin/ exists
  mkdirSync(BIN_DIR, { recursive: true });

  const url = `${BASE_URL}/${asset}`;
  const zipPath = join(BIN_DIR, asset);

  try {
    await download(url, zipPath);
    log('Download complete.');

    extractZip(zipPath, BIN_DIR);

    // Make binary executable on macOS/Linux
    if (!IS_WINDOWS) {
      chmodSync(BINARY_PATH, 0o755);
      log(`Set executable permission on ${BINARY_NAME}`);
    }

    // Clean up zip
    unlinkSync(zipPath);
    log('Cleaned up archive.');

    // Verify
    if (existsSync(BINARY_PATH)) {
      log(`V2Ray ${V2RAY_VERSION} installed successfully to ${BIN_DIR}`);
    } else {
      log('ERROR: Binary not found after extraction!');
      process.exit(1);
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    // Clean up partial download
    if (existsSync(zipPath)) {
      unlinkSync(zipPath);
    }
    process.exit(1);
  }
}

main();
