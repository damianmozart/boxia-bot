#!/usr/bin/env node
/*
 * freebox-draw.mjs — automasi Daily Free Blind Box draw.
 * Akun target ditentukan config `freeBoxTargets` (default: West said, Femzy,
 * Boxkia 27895). Akun target harus ada di `accounts` (boleh ditandai
 * `freeBoxOnly: true` supaya TIDAK ikut event treasure hunt).
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
// Override lewat env dipakai buat tes lawan API tiruan (sama seperti bot.mjs
// punya BOXKIA_API_BASE) — tanpa ini perilaku "jangan spam notif" nggak bisa
// diverifikasi otomatis.
const BASE = (process.env.BOXKIA_FREEBOX_API_BASE || 'https://api.boxkia.com/api/v3').replace(/\/$/, '');
const NTFY_TOPIC = process.env.BOXKIA_NTFY_TOPIC || CFG.ntfyTopic;
const NTFY_URL = process.env.BOXKIA_NTFY_URL || 'https://ntfy.sh/';
const BOX_ID = Number(process.env.FREEBOX_ID || CFG.freeBoxId || 67122);
const TARGETS = CFG.freeBoxTargets || ['West said', 'Femzy', 'Boxkia 27895', 'syawarman'];
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
  if (!NTFY_TOPIC) return;
  try {
    const res = await fetch(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: NTFY_TOPIC, title, message: msg }),
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

// Ambil status dengan satu kali retry. Server Boxkia sesekali menahan koneksi
// sampai timeout; kalau langsung menyerah, akun itu DILEWATI (padahal box-nya
// mungkin sudah siap) dan notifnya berbunyi seperti masalah nyata — padahal
// cuma hiccup. Retry bikin draw-nya lebih jarang kelewat sekaligus menekan
// alarm palsu. Retry hanya untuk status (GET), bukan submit (bisa dobel draw).
async function getStatus(acct) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const d = await api(`${BASE}/home/extraIntegral/freeBlindBox/detail?blind_box_id=${BOX_ID}`, acct);
      const info = d.data?.free_blind_box_info || null;
      if (info) return info;
      lastErr = null;   // server menjawab, tapi memang belum ada info box
    } catch (e) {
      lastErr = e;
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
  }
  if (lastErr) throw lastErr;
  return null;
}

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
  //
  // Error jaringan sesaat (timeout / fetch failed) TIDAK boleh memicu notif pada
  // tiap run: server Boxkia memang kadang menahan satu koneksi, dan cron kami
  // jalan tiap 5 menit — hasilnya HP kebanjiran "⚠️ Free Box: N error" padahal
  // cuma hiccup sesaat. Yang tetap dinotifikasi: kemenangan, box siap draw,
  // error yang BUKAN jaringan (mis. token mati / code dari server), dan kondisi
  // saat SEMUA target gagal sekaligus (itu baru masalah nyata).
  const TRANSIENT = /fetch failed|aborted|timeout|socket|ECONN|EAI_AGAIN|terminated|network/i;
  const hardErrors = errors.filter((e) => !TRANSIENT.test(String(e.msg || '')));
  const allFailed = errors.length > 0 && errors.length === results.length;
  const worthNotifying = NOTIFY_ALL || won.length > 0 || ready.length > 0 || hardErrors.length > 0 || allFailed;
  if (errors.length && !worthNotifying) {
    log(`  (${errors.length} error jaringan sesaat — notif dilewati biar HP nggak spam)`);
  }
  // Kalau SEMUA akun gagal tapi semuanya cuma masalah jaringan, jangan berteriak
  // "error" seolah botnya rusak — 22/9 20:41 persis ini yang terjadi (koneksi ke
  // Boxkia ngadat sesaat, 9/9 request jadwal timeout bersamaan). Judulnya dibuat
  // jujur menyebut jaringan, dan detailnya menegaskan box TIDAK hilang karena
  // putaran berikutnya masih mencoba (draw-nya idempoten).
  const allTransient = errors.length > 0 && hardErrors.length === 0;
  const head = won.length
    ? `🎁 Free Box: ${won.length} MENANG!`
    : ready.length
      ? `🎯 Free Box: ${ready.length} siap draw`
      : allTransient
        ? `🌐 Free Box: gangguan jaringan (${errors.length} akun)`
        : errors.length
          ? `⚠️ Free Box: ${errors.length} error`
          : `🎲 Free Box: ${drawn.length} sudah draw`;

  const detail = (allTransient ? ['(gangguan jaringan sesaat — dicoba lagi otomatis, box tidak hilang)'] : []).concat(results.map((r) => {
    if (r.kind === 'won') return `🎁 ${r.name}: ${r.prize}`;
    if (r.kind === 'ready') return `🎯 ${r.name}: siap draw`;
    if (r.kind === 'already') return `⏳ ${r.name}: sudah draw`;
    if (r.kind === 'locked') return `🔒 ${r.name}: ${r.msg}`;
    return `❌ ${r.name}: ${r.msg}`;
  })).join('\n');

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
