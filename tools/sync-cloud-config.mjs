#!/usr/bin/env node
/*
 * sync-cloud-config.mjs — dorong config.json lokal ke GitHub Secret
 * `BOXKIA_CONFIG` yang dipakai workflow Actions.
 *
 * Kenapa perlu: config.json TIDAK di-commit (isinya token akun) dan repo ini
 * publik, jadi cloud mengambilnya dari Secret. Kalau Secret-nya ketinggalan,
 * cloud jalan dengan daftar akun lama — kejadian nyata: akun `syawarman`
 * sudah aktif di laptop tapi cloud masih 3 akun free box.
 *
 * GitHub mewajibkan nilai secret dienkripsi libsodium `crypto_box_seal`,
 * jadi skrip ini butuh dependency (ada di tools/package.json — sengaja dipisah
 * supaya bot di root tetap zero-dependency).
 *
 * Pakai:
 *   cd tools && npm install     # sekali saja
 *   node sync-cloud-config.mjs  # dari folder tools
 *   node sync-cloud-config.mjs --dry   # cuma lihat ringkasan, tidak menulis
 *
 * Token GitHub diambil dari env GH_TOKEN / GITHUB_TOKEN, atau otomatis dari
 * Git Credential Manager lewat `git credential fill`.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Catatan: build ESM libsodium-wrappers 0.7.16 rusak di node_modules datar
// (`import "./libsodium.mjs"` menunjuk ke berkas yang tidak ada), jadi pakai
// build CommonJS-nya lewat createRequire.
const sodium = createRequire(import.meta.url)('libsodium-wrappers');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SECRET_NAME = 'BOXKIA_CONFIG';
const DRY = process.argv.includes('--dry');

function ghToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    // git credential fill membaca stdin — jalan baik di bash maupun cmd.
    const out = execSync('git credential fill', {
      cwd: ROOT,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    });
    const line = out.split('\n').find((l) => l.startsWith('password='));
    if (line) return line.slice('password='.length).trim();
  } catch { /* jatuh ke error di bawah */ }
  throw new Error('Token GitHub tidak ditemukan. Set GH_TOKEN lalu jalankan ulang.');
}

function repoSlug() {
  const url = execSync('git remote get-url origin', { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!m) throw new Error(`Tidak bisa membaca repo dari remote: ${url}`);
  return `${m[1]}/${m[2]}`;
}

const token = ghToken();
const repo = repoSlug();
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'boxkia-bot-sync',
  'X-GitHub-Api-Version': '2022-11-28',
};

const raw = readFileSync(resolve(ROOT, 'config.json'), 'utf8');
const cfg = JSON.parse(raw);
const accounts = cfg.accounts || [];
const fbOnly = accounts.filter((a) => a.freeBoxOnly).map((a) => a.name);

console.log(`repo          : ${repo}`);
console.log(`secret        : ${SECRET_NAME}`);
console.log(`config lokal  : ${raw.length} byte, ${accounts.length} akun`);
console.log(`akun event    : ${accounts.filter((a) => !a.freeBoxOnly).length}`);
console.log(`khusus freebox: ${fbOnly.length ? fbOnly.join(', ') : '-'}`);
console.log(`freeBoxTargets: ${(cfg.freeBoxTargets || []).join(', ') || '-'}`);

if (DRY) { console.log('\n(--dry: tidak menulis apa pun)'); process.exit(0); }

const pubRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, { headers: H });
if (!pubRes.ok) throw new Error(`ambil public-key gagal: HTTP ${pubRes.status} ${await pubRes.text()}`);
const { key, key_id } = await pubRes.json();

await sodium.ready;
const sealed = sodium.crypto_box_seal(sodium.from_string(raw), sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
const encrypted_value = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${SECRET_NAME}`, {
  method: 'PUT',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ encrypted_value, key_id }),
});
if (putRes.status !== 201 && putRes.status !== 204) {
  throw new Error(`tulis secret gagal: HTTP ${putRes.status} ${await putRes.text()}`);
}
console.log(`\n✅ Secret ${SECRET_NAME} diperbarui (HTTP ${putRes.status}) — cloud sekarang pakai config ini di run berikutnya.`);

const check = await (await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${SECRET_NAME}`, { headers: H })).json();
console.log(`   updated_at: ${check.updated_at}`);
