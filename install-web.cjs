/**
 * Install dsh-todo-discipline into THIS machine's web profile.
 *
 * Same approach as install.cjs, with the paths corrected for this machine:
 *   1. pnpm add link:<plugin dir> inside the profile
 *   2. append the bundle id to dsh.profile.bundles
 *
 * Idempotent; prints what it changed and exits non-zero on failure.
 */
const { execFileSync } = require('node:child_process');
const { existsSync, lstatSync, readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const PROFILE = join(os.homedir(), '.dsh', 'profiles', 'web');
const PLUGIN_DIR = __dirname;
const ID = 'dsh-todo-discipline';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

function step(title) {
  console.log(`\n=== ${title}`);
}

// ---- 0. backups -----------------------------------------------------------
step('backup');
for (const file of ['package.json', 'pnpm-lock.yaml']) {
  const src = join(PROFILE, file);
  if (existsSync(src) === false) {
    console.log(`skip (missing): ${file}`);
    continue;
  }
  const dst = `${src}.bak-${STAMP}`;
  copyFileSync(src, dst);
  console.log(`backed up: ${dst}`);
}

// ---- 1. pnpm add link: ----------------------------------------------------
step('pnpm add link:');
const spec = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`;
console.log('spec:', spec);
try {
  const out = execFileSync('pnpm', ['add', spec, '--reporter=append-only'], {
    cwd: PROFILE,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
    shell: true,
  });
  console.log(out.trim().split('\n').slice(-15).join('\n'));
} catch (error) {
  console.log('STDOUT:', String(error.stdout ?? '').trim().split('\n').slice(-20).join('\n'));
  console.log('STDERR:', String(error.stderr ?? '').trim().split('\n').slice(-20).join('\n'));
  console.log('pnpm failed; inspecting state before deciding');
}

// ---- 2. bundles -----------------------------------------------------------
step('manifest');
const manifestPath = join(PROFILE, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log('dependency:', manifest.dependencies?.[ID] ?? '(absent)');
console.log('bundles:', manifest.dsh.profile.bundles.join(', '));

if (manifest.dependencies?.[ID] === undefined) {
  console.error('\nFAIL: the dependency did not land in package.json; not touching bundles');
  process.exit(1);
}

if (manifest.dsh.profile.bundles.includes(ID) === false) {
  manifest.dsh.profile.bundles.push(ID);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  step('appended bundle');
  console.log('bundles:', manifest.dsh.profile.bundles.join(', '));
} else {
  step('bundle already listed');
}

// ---- 3. module layout -----------------------------------------------------
step('module layout');
const mod = join(PROFILE, 'node_modules', ID);
const stat = lstatSync(mod, { throwIfNoEntry: false });
if (stat === undefined) {
  console.error('MISSING:', mod);
  process.exit(1);
}
console.log('link:', stat.isSymbolicLink(), 'dir:', stat.isDirectory());
const pkg = JSON.parse(readFileSync(join(mod, 'package.json'), 'utf8'));
console.log('resolved version:', pkg.version, 'patch:', pkg.dsh.bundle.patch);
for (const file of ['index.js', 'state.js', 'schema.js', 'cordis.patch.yml']) {
  console.log(`  ${file}:`, existsSync(join(mod, file)));
}
console.log('\nOK: install finished');
