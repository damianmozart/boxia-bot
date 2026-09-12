#!/usr/bin/env node
// TEMPORARY test harness — hapus setelah dipakai.
// Mock API Boxkia buat verifikasi penjadwal ARM → FIRE:
//   - event palsu mulai T0 (6 detik setelah mock nyala)
//   - join sebelum T0 -> "not started" (code 1)
//   - tepat/sesudah T0 -> campur: code 0, duplicate, "Too slow, all gone"
//   - mencatat SEMUA request list + join beserta waktunya, buat cek:
//       (a) nggak ada request /luckyBag/list di jendela kritis (T0-1s .. T0+1s)
//       (b) join pertama mendarat dekat T0
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 8099;
const T0 = Date.now() + 6000;
const FREEBOX_DELAY_MS = 2500;
// State bot (log + reported-events.json) diarahkan ke folder sementara: tanpa ini
// run kedua langsung "sudah dilaporkan" dari file run pertama dan laporan nggak
// pernah dikirim — test jadi flaky.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'boxkia-arm-'));
const log = [];
let listCalls = [];
const joinFirstAt = new Map();
const joinByEvent = new Map(); // eventId -> { first, tokens:Set }

const JSON_H = { 'Content-Type': 'application/json' };

function schedule() {
  return {
    code: 0,
    msg: 'ok',
    data: {
      activity_info: { user_spend_amount: '0.00' },
      list: [
        {
          id: 999, type: 1, start_time: 'MOCK 01:00 PM', is_progress: 0, is_join: 0,
          join_total: 0, join_user_limit: 100, limit_price: 0, level_limit: 0,
          diff_time_start: Math.max(0, T0 - Date.now()),
        },
        {
          // free box (type 0) mulai barengan: HARUS ditembak beberapa detik
          // SETELAH mulai (delay), bukan pas dibuka
          id: 1001, type: 0, start_time: 'MOCK 01:00 PM', is_progress: 0, is_join: 0,
          join_total: 0, join_user_limit: 70, limit_price: 0, level_limit: 0,
          diff_time_start: Math.max(0, T0 - Date.now()),
        },
        {
          // event jauh (20 menit lagi) — bot harus keluar cepat, bukan muter-muter
          // nunggu sampai budget habis
          id: 1000, type: 1, start_time: 'MOCK 02:00 PM', is_progress: 0, is_join: 0,
          join_total: 0, join_user_limit: 100, limit_price: 0, level_limit: 0,
          diff_time_start: (T0 - Date.now()) + 20 * 60 * 1000,
        },
      ],
    },
  };
}

const bucketByToken = new Map();
const userByToken = new Map();
function joinResult(token, id) {
  if (Date.now() < T0) return { code: 1, msg: 'not started yet' };
  if (id === 1001) return { code: 0, msg: 'ok', data: {} }; // free box: selalu sukses
  const bucket = bucketByToken.get(token) ?? 2;
  if (bucket === 0) return { code: 1, msg: 'Duplicate participation not allowed' };
  if (bucket === 1) return { code: 1, msg: 'Too slow, all gone' };
  return { code: 0, msg: 'ok', data: {} };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url || '';
    const tok = req.headers.token || 'none';
    if (url.includes('/activity/luckyBag/list')) {
      listCalls.push(Date.now());
      return res.writeHead(200, JSON_H).end(JSON.stringify(schedule()));
    }
    if (url.includes('/activity/luckyBag/join')) {
      const now = Date.now();
      if (!joinFirstAt.has(tok)) joinFirstAt.set(tok, now);
      let id = null;
      try { id = JSON.parse(body || '{}').id; } catch { /* biarkan null */ }
      if (id != null) {
        if (!joinByEvent.has(id)) joinByEvent.set(id, { first: now, tokens: new Set() });
        joinByEvent.get(id).tokens.add(tok);
      }
      return res.writeHead(200, JSON_H).end(JSON.stringify(joinResult(tok, id)));
    }
    if (url.includes('/activity/luckyBag/record')) {
      // Daftar peserta palsu, dibedakan per tipe seperti API asli:
      //   angpao (#999)  : SEMUA peserta dapat bagian (is_win cuma penanda share terbesar)
      //   free-box (#1001): hadiah jatuh ke satu pemenang, sisanya amount 0
      const evId = Number(new URL(url, `http://127.0.0.1:${PORT}`).searchParams.get('id'));
      const isAngpao = evId === 999;
      const list = [...userByToken.entries()].map(([, uid], i) => ({
        id: 5000 + i,
        user_id: uid,
        is_win: isAngpao ? (i === 0 ? 1 : 0) : (i % 3 === 0 ? 1 : 0),
        join_date: '01:00:02 PM',
        sale_num: (i * 7) % 60 + 1,
        amount: isAngpao ? '4500.00' : (i % 3 === 0 ? '350000.00' : '0.00'),
        user_nickname: `mock${i}`,
      }));
      return res.writeHead(200, JSON_H).end(JSON.stringify({ code: 0, data: { list, count: list.length } }));
    }
    if (url.includes('/user/info')) {
      if (!bucketByToken.has(tok)) {
        bucketByToken.set(tok, bucketByToken.size % 3);
        userByToken.set(tok, 1000 + userByToken.size);
      }
      const i = [...bucketByToken.keys()].indexOf(tok);
      return res.writeHead(200, JSON_H).end(JSON.stringify({
        code: 0, msg: 'ok',
        data: { nickname: `mock${i}`, user_id: userByToken.get(tok), user_level: 9, balance: '1000', integral: '5' },
      }));
    }
    res.writeHead(404, JSON_H).end(JSON.stringify({ code: 404, msg: 'no route' }));
  });
});

function run() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['bot.mjs', '--actions'], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        BOXKIA_API_BASE: `http://127.0.0.1:${PORT}`,
        BOXKIA_NTFY_TOPIC: '',
        DATA_DIR,
        ACTIONS_BUDGET_MS: '60000',
        BOXKIA_FREEBOX_DELAY_MS: String(FREEBOX_DELAY_MS),
        BOXKIA_FREEBOX_JITTER_MS: '0',
      },
    });
    let out = '';
    const deadline = setTimeout(() => p.kill('SIGKILL'), 45000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => { clearTimeout(deadline); resolve({ out, exitAt: Date.now() }); });
  });
}

server.listen(PORT, '127.0.0.1', async () => {
  log.push(`mock nyala di :${PORT} — T0 dalam 6s`);
  const run_ = await run();
  const out = run_.out;
  console.log(out);

  const head = out.split('\n').filter((l) => /arm|tembak|📣|nembak|keluar/.test(l));
  console.log('\n=== ringkasan log bot ===');
  console.log(head.join('\n'));

  const fired = [...joinFirstAt.values()];
  const firstJoin = fired.length ? Math.min(...fired) : null;
  const angpaoT0 = joinByEvent.get(999)?.first ?? null;
  const freeT0 = joinByEvent.get(1001)?.first ?? null;
  // jendela kritis = sebelum & saat tembakan (setelah burst, request list lagi itu wajar)
  const critStart = T0 - 1000, critEnd = T0 + 150;
  const listInCritical = listCalls.filter((t) => t >= critStart && t <= critEnd).length;
  const lastListBefore = listCalls.filter((t) => t < critStart).length;

  // blok teks laporan tiap event, biar check-nya nggak ketuker antar tipe event
  const blockOf = (marker) => {
    const i = out.indexOf(marker);
    return i < 0 ? '' : out.slice(i).split('\n').slice(0, 12).join('\n');
  };
  const angReport = blockOf('angpao #999 · MOCK');
  const freeReport = blockOf('free-box #1001 · MOCK');

  const checks = [
    ['event di-arm', /🛡 arm angpao #999/.test(out)],
    ['tidur presisi (bukan fast-poll)', /💤 tidur presisi/.test(out)],
    ['akun nembak join', /⚡ angpao #999/.test(out)],
    ['ada join yang mendarat', fired.length > 0],
    ['join pertama ≤ 700ms setelah T0', firstJoin != null && firstJoin - T0 <= 700],
    ['NGGAK ada polling list di jendela kritis', listInCritical === 0],
    ['ringkasan hasil dicetak', /📣 angpao #999/.test(out)],
    ['kode terminal (too slow) dihentikan & dilaporkan', /kalah cepat|sudah ikut/.test(out)],
    ['akun yang menang tercatat ikut', /✅3 ikut/.test(out)],
    ['free box di-arm pakai delay (bukan lead)', /🛡 arm free-box #1001 — tembak dalam \d+ms .*delay \d+ms/.test(out)],
    ['free box ditembak SETELAH mulai (>1.8s)', freeT0 != null && freeT0 - T0 > 1800],
    ['free box tidak lebih awal dari delay yang diminta', freeT0 != null && freeT0 - T0 >= FREEBOX_DELAY_MS - 300],
    ['angpao tetap tepat waktu (≤600ms setelah mulai)', angpaoT0 != null && angpaoT0 - T0 <= 600],
    ['free box lebih lambat dari angpao', freeT0 != null && angpaoT0 != null && freeT0 > angpaoT0],
    ['event jauh → keluar cepat (bukan nyangkut sampai budget)', /budget tersisa/.test(out) && run_.exitAt - T0 < 8000],
    ['laporan hasil undian terkirim dengan POSISI tiap akun', /posisi \d+\/\d+/.test(out)],
    ['laporan menyebut berapa yang DIDAPAT', /dapat Rp \d/.test(out)],
    ['laporan menghitung total kemenangan', /Total didapat|Posisi terbaik/.test(out)],
    // angpao: bagian yang didapat SEMUA peserta harus dihitung, bukan cuma is_win
    ['angpao menghitung bagian semua peserta', /💰 angpao: 9 akun dapat Rp 40\.500,00/.test(out)],
    ['angpao: tiap akun dapat bagian (bukan Rp 0)', /dapat Rp 4\.500,00/.test(angReport) && !/dapat Rp 0,00/.test(angReport)],
    ['free-box: yang bukan pemenang tetap Rp 0', /dapat Rp 0,00/.test(freeReport)],
  ];
  console.log('\n=== hasil verifikasi ===');
  let bad = 0;
  for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? '✅' : '❌'} ${name}`); }
  console.log(`\nlist calls total: ${listCalls.length} (sebelum jendela kritis: ${lastListBefore}, di dalam: ${listInCritical})`);
  console.log(`offset list calls vs T0: ${listCalls.map((t) => t - T0).join(', ')}`);
  console.log(`offset join pertama vs T0: ${[...joinFirstAt.entries()].map(([k, v]) => `${k.slice(0, 6)}=${v - T0}`).join(', ')}`);
  console.log(`T0-relative join pertama (semua): ${firstJoin == null ? 'n/a' : (firstJoin - T0) + 'ms'}`);
  console.log(`angpao #999 join pertama: ${angpaoT0 == null ? 'n/a' : (angpaoT0 - T0) + 'ms'} (${joinByEvent.get(999)?.tokens.size ?? 0} akun)`);
  console.log(`free-box #1001 join pertama: ${freeT0 == null ? 'n/a' : (freeT0 - T0) + 'ms'} (${joinByEvent.get(1001)?.tokens.size ?? 0} akun), delay diminta ${FREEBOX_DELAY_MS}ms`);
  console.log(bad ? `\n❌ ${bad} check gagal` : '\n✅ SEMUA CHECK LULUS');
  server.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* abaikan */ }
  process.exit(bad ? 1 : 0);
});
