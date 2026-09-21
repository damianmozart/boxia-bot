#!/usr/bin/env node
/*
 * test-day-roll.mjs — regresi buat bug "bot lokal berhenti menembak setelah sehari".
 *
 * ID event Boxkia dipakai ulang tiap hari (angpao #244 muncul lagi besoknya).
 * Dulu `attempted` cuma diisi sekali di awal proses dan tidak pernah dibersihkan,
 * jadi proses yang hidup >1 hari diam-diam melewati event yang id-nya sudah
 * pernah ditembak — tanpa satu baris log pun.
 *
 * Tes ini menjalankan bot DUA KALI terhadap mock yang menyajikan event dengan ID
 * SAMA berulang tiap 5 detik:
 *   1. TANPA hook pergantian hari  → HARUS cuma 1 tembakan (bug aslinya).
 *      Kalau ini jadi >1, berarti batas harian hilang dan bot bisa nembak
 *      berulang kali di event yang sama — juga salah.
 *   2. DENGAN hook (roll tiap 7 detik) → HARUS ≥2 tembakan, bukti state di-reset.
 * Jadi tes ini merah baik kalau reset-nya hilang, maupun kalau reset-nya terlalu
 * agresif (batas harian nggak lagi menghalangi tembakan ulang di hari yang sama).
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// CATATAN: tes ini sengaja pakai mode BOT LOKAL (bukan --actions). Mode Actions
// keluar begitu tidak ada target tersisa, jadi bug lintas-hari di sana muncul
// sebagai "sesi berhenti", sedangkan di bot lokal muncul sebagai "diam-diam
// nggak nembak" — dan yang terakhir ini yang bikin bot kamu berhenti 2 hari.
// Daily Free Blind Box dimatikan (BOXKIA_FREEBOX_CHECK_MIN=0) supaya tanpa
// sengaja menggambar box akun sungguhan.

const PORT = 8097;
const WINDOW_MS = 5000;         // event "baru" tiap 5 detik (mewakili id yang dipakai ulang)
const EVENT_ID = 700;
const RUN_MS = 20000;           // lama tiap run (mode bot lokal, loop panjang)
const boot = Date.now();
const joinHits = [];
let listCalls = 0;

const JSON_H = { 'Content-Type': 'application/json' };

function schedule() {
  const now = Date.now();
  const toNext = WINDOW_MS - ((now - boot) % WINDOW_MS);
  return {
    code: 0,
    msg: 'ok',
    data: {
      activity_info: { user_spend_amount: '0.00' },
      list: [
        {
          id: EVENT_ID, type: 1, start_time: 'MOCK 01:00 PM', is_progress: 0, is_join: 0,
          join_total: 0, join_user_limit: 100, limit_price: 0, level_limit: 0,
          diff_time_start: toNext,
        },
      ],
    },
  };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url || '';
    const tok = req.headers.token || 'none';
    if (url.includes('/activity/luckyBag/list')) {
      listCalls++;
      return res.writeHead(200, JSON_H).end(JSON.stringify(schedule()));
    }
    if (url.includes('/activity/luckyBag/join')) {
      joinHits.push({ at: Date.now(), tok });
      return res.writeHead(200, JSON_H).end(JSON.stringify({ code: 0, msg: 'ok', data: {} }));
    }
    if (url.includes('/activity/luckyBag/record')) {
      const list = [{ id: 1, user_id: 1000, is_win: 1, join_date: '01:00:01 PM', sale_num: 3, amount: '9000.00', user_nickname: 'mock0' }];
      return res.writeHead(200, JSON_H).end(JSON.stringify({ code: 0, data: { list, count: 1 } }));
    }
    if (url.includes('/user/info')) {
      return res.writeHead(200, JSON_H).end(JSON.stringify({
        code: 0, msg: 'ok',
        data: { nickname: 'mock0', user_id: 1000, user_level: 9, balance: '1000', integral: '5' },
      }));
    }
    res.writeHead(404, JSON_H).end(JSON.stringify({ code: 404, msg: 'no route' }));
  });
});

function runBot(extraEnv) {
  return new Promise((resolve) => {
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'boxkia-dayroll-'));
    const p = spawn(process.execPath, ['bot.mjs'], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        BOXKIA_API_BASE: `http://127.0.0.1:${PORT}`,
        BOXKIA_NTFY_TOPIC: '',
        BOXKIA_FREEBOX_CHECK_MIN: '0',
        BOXKIA_POLL_MS: '1000',
        DATA_DIR,
        ...extraEnv,
      },
    });
    let out = '';
    const stopper = setTimeout(() => p.kill('SIGTERM'), RUN_MS);
    const deadline = setTimeout(() => p.kill('SIGKILL'), RUN_MS + 15000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      clearTimeout(stopper);
      clearTimeout(deadline);
      try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* abaikan */ }
      resolve(out);
    });
  });
}

const fires = (out) => (out.match(/⚡ angpao #700/g) || []).length;
const rolls = (out) => (out.match(/🔄 Ganti hari/g) || []).length;

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`mock nyala di :${PORT} — event #${EVENT_ID} tiap ${WINDOW_MS / 1000}s, tiap run ${RUN_MS / 1000}s\n`);

  console.log('--- run 1: tanpa reset harian (harus 1 tembakan) ---');
  const outBug = await runBot({});
  const f1 = fires(outBug), r1 = rolls(outBug);
  console.log(outBug.split('\n').filter((l) => /⚡|⏭.*700|🔄|📣|budget/.test(l)).slice(0, 12).join('\n'));
  console.log(`  → tembakan #700: ${f1}, reset harian: ${r1} (poll list ${listCalls})\n`);

  console.log('--- run 2: dengan pergantian hari tiap 7s (harus ≥2 tembakan) ---');
  const outFix = await runBot({ BOXKIA_FORCE_DAY_ROLL_MS: '7000' });
  const f2 = fires(outFix), r2 = rolls(outFix);
  console.log(outFix.split('\n').filter((l) => /⚡|⏭.*700|🔄|📣|budget/.test(l)).slice(0, 16).join('\n'));
  console.log(`  → tembakan #700: ${f2}, reset harian: ${r2}\n`);

  const checks = [
    ['hari yang sama: TIDAK menembak ulang event yang sama (cuma 1 tembakan)', f1 === 1],
    ['tanpa reset: nggak ada log "Ganti hari"', r1 === 0],
    ['setelah ganti hari: event yang sama DITEMBAK LAGI (≥2)', f2 >= 2],
    ['pergantian hari tercatat di log (≥2 reset)', r2 >= 2],
    ['pergantian hari memicu tembakan tambahan vs tanpa reset', f2 > f1],
  ];

  console.log('=== hasil verifikasi ===');
  let bad = 0;
  for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? '✅' : '❌'} ${name}`); }
  console.log(bad ? `\n❌ ${bad} check gagal` : '\n✅ SEMUA CHECK LULUS');
  server.close();
  process.exit(bad ? 1 : 0);
});
