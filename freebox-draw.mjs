#!/usr/bin/env node
/*
 * freebox-draw.mjs — automasi Daily Free Blind Box draw.
 * Khusus 3 akun: West said, Boxkia 27895 (403279), Femzy.
 *
 * API:
 *   GET  /api/v3/home/extraIntegral/freeBlindBox/detail?blind_box_id=<id>
 *   POST /api/v3/home/extraIntegral/freeBlindBox/submit {blind_box_id: <id>}
 *
 * free_blind_box_info:
 *   status          0 = locked (level kurang), 1 = siap draw, 2 = sudah draw
 *   level           level box (2 = LV2 FREE BLIND BOX)
 *   next_time_unix  DURASI (ms) sampai reset — jadi reset itu 24 jam bergulir
 *                   dari draw terakhir, BUKAN jam 00:00 global. Makanya cron-nya
 *                   tiap jam, bukan 2x sehari: tiap akun punya jam reset sendiri.
 *
 * Mode:
 *   node freebox-draw.mjs               — draw yang siap, notif cuma kalau ada aksi
 *   node freebox-draw.mjs --check       — cek status saja, jangan draw
 *   node freebox-draw.mjs --notify-all  — paksa kirim notif walau nggak ada aksi
 *
 * Config (config.json, opsional):
 *   freeBoxId      — id box (default 67122 = LV2)
 *   freeBoxTargets — daftar nickname target (default 3 akun di atas)
 */

import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BASE = 'https://api.boxkia.com/api/v3';
const BOX_ID = Number(process.env.FREEBOX_ID || CFG.freeBoxId || 67122);
const TARGETS = CFG.freeBoxTargets || ['West said', 'Femzy', 'Boxkia 27895'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOG_FILE = path.join(DATA_DIR, 'freebox-draw.log');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const NOTIFY_ALL = args.has('--notify-all');

function log(...parts) {
  const line = `[${new Date().toLocaleString('id-ID')}] ${parts.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* abaikan */ }
}

async function ntfy(title, msg) {
  if (!CFG.ntfyTopic) return;
  try {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: CFG.ntfyTopic, title, message: msg }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) log(`⚠ ntfy gagal: HTTP ${res.status}`);
  } catch (e) {
    log(`⚠ ntfy gagal: ${e?.message || e}`);
  }
}

async function api(url, acct, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      token: acct.token,
      lang: acct.lang || 'id',
      'X-Device-VisitorId': acct.visitorId || 'boxkia-bot',
      'User-Agent': UA,
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

const getStatus = (acct) =>
  api(`${BASE}/home/extraIntegral/freeBlindBox/detail?blind_box_id=${BOX_ID}`, acct)
    .then((d) => d.data?.free_blind_box_info || null);

const draw = (acct) =>
  api(`${BASE}/home/extraIntegral/freeBlindBox/submit`, acct, 'POST', { blind_box_id: BOX_ID });

// Satu akun, terisolasi: error di akun ini nggak boleh menggagalkan akun lain.
async function handleAccount(acct) {
  const tag = acct.name;
  const info = await getStatus(acct);
  if (!info) return { name: acct.name, kind: 'error', msg: 'gagal ambil status' };

  const lvl = `LV${info.level}`;
  if (info.status === 0) {
    log(`  🔒 ${tag} — belum kebuka (${lvl})`);
    return { name: acct.name, kind: 'locked', msg: `belum LV${info.level}` };
  }
  if (info.status === 2) {
    const h = (Number(info.next_time_unix || 0) / 3600000).toFixed(1);
    log(`  ⏳ ${tag} — sudah draw, reset ~${h} jam lagi`);
    return { name: acct.name, kind: 'already', msg: `reset ~${h} jam` };
  }
  if (info.status !== 1) {
    log(`  ❓ ${tag} — status tak dikenal: ${info.status}`);
    return { name: acct.name, kind: 'error', msg: `status ${info.status}` };
  }

  if (CHECK_ONLY) {
    log(`  ✅ ${tag} — SIAP DRAW (mode cek)`);
    return { name: acct.name, kind: 'ready', msg: 'siap draw' };
  }

  log(`  🎯 ${tag} — DRAWING...`);
  const r = await draw(acct);
  if (r.code !== 0) {
    log(`  ❌ ${tag} — gagal: code=${r.code} ${r.msg || ''}`);
    return { name: acct.name, kind: 'error', msg: `${r.code} ${r.msg || ''}`.trim() };
  }
  const item = r.data?.list_raw?.[0];
  const prize = [item?.winning_rank_name, item?.name].filter(Boolean).join(' ') || 'hadiah';
  log(`  🎁 ${tag} — MENANG: ${prize}`);
  return { name: acct.name, kind: 'won', prize };
}

async function main() {
  const accounts = (CFG.accounts || []).filter((a) => a.token && TARGETS.includes(a.name));
  if (!accounts.length) {
    log(`⚠ Tidak ada akun target (${TARGETS.join(', ')}) di config.json — batal.`);
    await ntfy('❌ Free Box: konfigurasi kosong', `Tidak ada akun target (${TARGETS.join(', ')}) di config.json.`);
    return;
  }

  log(`🎲 Free Blind Box ${BOX_ID} — ${accounts.length} akun target${CHECK_ONLY ? ' (cek saja)' : ''}`);

  // Semua akun diproses PARALEL — dulu berurutan, jadi satu akun lambat
  // bikin akun terakhir kehabisan waktu. allSettled biar satu error nggak
  // menumbangkan sisanya (sebelumnya throw = FATAL, semua akun nggak dilaporin).
  const settled = await Promise.allSettled(accounts.map(handleAccount));
  const results = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { name: accounts[i].name, kind: 'error', msg: String(s.reason?.message || s.reason) }
  );

  const won = results.filter((r) => r.kind === 'won');
  const ready = results.filter((r) => r.kind === 'ready');
  const errors = results.filter((r) => r.kind === 'error');
  const drawn = results.filter((r) => r.kind === 'already');

  // Notif HANYA kalau ada sesuatu yang benar-benar terjadi (atau diminta paksa).
  // Cron jalan tiap jam; kalau tiap run kirim notif, HP bakal spam 24x sehari.
  // `--check` itu alat diagnostik — cukup tampil di terminal, jangan ping HP.
  const worthNotifying = NOTIFY_ALL || won.length > 0 || errors.length > 0;
  const head = won.length
    ? `🎁 Free Box: ${won.length} MENANG!`
    : ready.length
      ? `🎯 Free Box: ${ready.length} siap draw`
      : errors.length
        ? `⚠️ Free Box: ${errors.length} error`
        : `🎲 Free Box: ${drawn.length} sudah draw`;

  const detail = results.map((r) => {
    if (r.kind === 'won') return `🎁 ${r.name}: ${r.prize}`;
    if (r.kind === 'ready') return `🎯 ${r.name}: siap draw`;
    if (r.kind === 'already') return `⏳ ${r.name}: sudah draw`;
    if (r.kind === 'locked') return `🔒 ${r.name}: ${r.msg}`;
    return `❌ ${r.name}: ${r.msg}`;
  }).join('\n');

  log(head);
  log(detail);
  if (!worthNotifying) {
    log('  (tidak ada aksi — notif dilewati)');
    return;
  }
  await ntfy(head, detail);
}

main().catch(async (e) => {
  log('FATAL:', e?.message || e);
  await ntfy('❌ Free Box Error', e?.message || String(e));
  process.exit(1);
});
