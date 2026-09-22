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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
        ...(rescueAt ? [{
          id: 1002, type: 1, start_time: 'MOCK 03:00 PM', is_progress: 0, is_join: 0,
          join_total: 0, join_user_limit: 100, limit_price: 0, level_limit: 0,
          diff_time_start: Math.max(0, rescueAt - Date.now()),
        }] : []),
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

const notifs = [];       // {title, message} yang ditangkap mock ntfy
let allDup = false;      // mode "semua akun sudah ikut" buat menguji judul notif
// Skenario "rescue": tahan koneksi /luckyBag/list (bot timeout) + satu event
// yang mulai di `rescueAt` — buat menguji jaring pengaman arm.
let listHangFrom = 0;
let listHangUntil = 0;
let rescueAt = 0;
// token yang /user/info-nya dibikin gagal beberapa kali (meniru rate-limit sesaat),
// plus sisa berapa kali harus gagal.
const loginFail = new Map();
const bucketByToken = new Map();
const userByToken = new Map();
function joinResult(token, id) {
  if (allDup) return { code: 1, msg: 'Duplicate participation not allowed' };
  if (Date.now() < (id === 1002 ? rescueAt : T0)) return { code: 1, msg: 'not started yet' };
  if (id === 1001) return { code: 0, msg: 'ok', data: {} }; // free box: selalu sukses
  const bucket = bucketByToken.get(token) ?? 2;
  if (bucket === 0) return { code: 1, msg: 'Duplicate participation not allowed' };
  if (bucket === 1) return { code: 1, msg: 'Too slow, all gone' };
  return { code: 0, msg: 'ok', data: {} };
}

const server = http.createServer((req, res) => {
  let body = '';
  // POST ke root = notifikasi (mock ntfy lokal), supaya judul notif bisa diuji
  // tanpa mengirim apa pun ke HP.
  if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { notifs.push(JSON.parse(body)); } catch { notifs.push({ title: body }); }
      res.writeHead(200, JSON_H).end('{}');
    });
    return;
  }
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url || '';
    const tok = req.headers.token || 'none';
    if (url.includes('/activity/luckyBag/list')) {
      listCalls.push(Date.now());
      // skenario rescue: jangan jawab sama sekali → bot melepasnya karena timeout
      if (listHangFrom && Date.now() >= listHangFrom && Date.now() < listHangUntil) return;
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
      // gagal login sesaat (10003) — token VALID, cuma kena rate-limit
      const left = loginFail.get(tok) || 0;
      if (left > 0) {
        loginFail.set(tok, left - 1);
        return res.writeHead(200, JSON_H).end(JSON.stringify({ code: 10003, msg: 'Login required' }));
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

function run(opts = {}) {
  return new Promise((resolve) => {
    // tiap run dapat DATA_DIR sendiri: kalau dipakai bersama, run kedua langsung
    // "sudah dilaporkan" dari state run pertama dan laporannya nggak pernah dikirim.
    const dir = opts.dataDir || DATA_DIR;
    const p = spawn(process.execPath, ['bot.mjs', ...(opts.args || ['--actions'])], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        BOXKIA_API_BASE: `http://127.0.0.1:${PORT}`,
        BOXKIA_NTFY_TOPIC: 'uji',
        BOXKIA_NTFY_URL: `http://127.0.0.1:${PORT}/`,
        DATA_DIR: dir,
        ACTIONS_BUDGET_MS: '60000',
        BOXKIA_FREEBOX_DELAY_MS: String(FREEBOX_DELAY_MS),
        BOXKIA_FREEBOX_JITTER_MS: '0',
        ...(opts.env || {}),
      },
    });
    let out = '';
    const deadline = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs || 45000);
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

  // Total angpao = jumlah akun × Rp 4.500 (tiap peserta mock dapat 4500).
  // Jumlah akunnya TIDAK di-hardcode: mock-nya mengikuti config.json, jadi
  // begitu ada akun baru (mis. syawarman) angka 9/40.500 jadi usang.
  const angSum = out.match(/💰 angpao: (\d+) akun dapat Rp ([\d.,]+)/);
  const angCount = angSum ? Number(angSum[1]) : 0;
  const angTotal = angSum ? Number(angSum[2].replace(/\./g, '').replace(',', '.')) : NaN;

  // --- run 2: semua akun balas "Duplicate participation" (artinya sudah ikut lewat
  // runner lain, mis. cloud). Dulu ini mengirim notif "⚠️ ada yang gagal" padahal
  // tidak ada satu pun yang gagal — bikin panik tanpa sebab.
  const notifsBefore = notifs.length;
  allDup = true;
  const dir2 = mkdtempSync(path.join(tmpdir(), 'boxkia-arm2-'));
  await run({ args: ['--once'], dataDir: dir2 });
  try { rmSync(dir2, { recursive: true, force: true }); } catch { /* abaikan */ }
  const title2 = notifs.slice(notifsBefore).map((n) => String(n.title || ''))[0] || '';
  console.log(`\n=== run 2 (semua akun sudah ikut) → judul notif: "${title2}" ===`);

  // --- run 3: satu akun gagal login 3x (rate-limit sesaat) tapi tokennya sehat.
  // Dulu laporan menyebutnya "token mati" dan jumlah "akun masuk" jadi kurang.
  const dir3 = mkdtempSync(path.join(tmpdir(), 'boxkia-arm3-'));
  const tokens = (JSON.parse(readFileSync(path.join(import.meta.dirname, 'config.json'), 'utf8')).accounts || [])
    .filter((x) => x.token).map((x) => x.token);
  loginFail.set(tokens[1], 3);
  const out3 = (await run({ args: ['--hasil', '999'], dataDir: dir3 })).out;
  loginFail.clear();
  try { rmSync(dir3, { recursive: true, force: true }); } catch { /* abaikan */ }
  const masuk3 = (out3.match(/· (\d+)\/(\d+) akun masuk/) || [])[0] || '(tidak ada laporan)';
  console.log(`\n=== run 3 (1 akun gagal login sesaat) → ${masuk3} ===`);
  console.log(out3.split('\n').filter((l) => /login ulang|tidak login|akun masuk|🔁/.test(l)).join('\n'));

  // --- run 4: RESCUE — fetch jadwal GAGAL (koneksi ditahan) tepat di jendela arm.
  // Kejadian nyata 22/9 20:41: 9/9 akun "error fetch list: aborted due to timeout".
  // Tanpa jaring pengaman, akun yang fetch-nya gagal tidak punya target → tidak
  // di-arm → baru menembak setelah event mulai (kalah cepat). Kontrolnya dijalankan
  // dengan BOXKIA_DISABLE_RESCUE_ARM supaya terbukti bedanya.
  const rescue = [];
  for (const disable of [false, true]) {
    joinByEvent.delete(1002);
    const ra = Date.now() + 12000;
    const hangFrom = Date.now() + 6000;   // biar ada satu fetch sukses dulu (cache terisi)
    const hangUntil = Date.now() + 22000;
    rescueAt = ra;
    listHangFrom = hangFrom;
    listHangUntil = hangUntil;
    const dirR = mkdtempSync(path.join(tmpdir(), 'boxkia-rescue-'));
    const r = await run({
      args: [],
      dataDir: dirR,
      timeoutMs: 16000,
      env: {
        BOXKIA_ARM_WINDOW_MS: '4000',
        BOXKIA_SCHEDULE_TIMEOUT_MS: '700',
        BOXKIA_POLL_MS: '1000',
        BOXKIA_FREEBOX_CHECK_MIN: '0',
        ...(disable ? { BOXKIA_DISABLE_RESCUE_ARM: '1' } : {}),
      },
    });
    rescue.push({ disable, out: r.out, rescueAt: ra, first: joinByEvent.get(1002)?.first ?? null });
    rescueAt = 0;
    listHangFrom = 0;
    listHangUntil = 0;
    try { rmSync(dirR, { recursive: true, force: true }); } catch { /* abaikan */ }
  }
  const fixR = rescue[0], ctlR = rescue[1];
  console.log(`\n=== run 4 rescue (fetch jadwal gagal di jendela arm) — dengan fix: join ${fixR.first == null ? 'TIDAK ADA' : (fixR.first - fixR.rescueAt) + 'ms setelah mulai'} · kontrol: ${ctlR.first == null ? 'TIDAK ADA' : (ctlR.first - ctlR.rescueAt) + 'ms setelah mulai'} ===`);
  console.log(fixR.out.split('\n').filter((l) => /🛟|arm angpao #1002|⚡ angpao #1002/.test(l)).join('\n'));

  const checks = [
    ['rescue: akun tetap di-arm walau fetch jadwal gagal', /🛟 \d+ akun di-arm dari jadwal terakhir/.test(fixR.out)],
    ['rescue: join mendarat tepat waktu (≤500ms setelah mulai)', fixR.first != null && Math.abs(fixR.first - fixR.rescueAt) <= 500],
    ['rescue: kontrol tanpa jaring pengaman TIDAK menembak (telat)', ctlR.first == null],
    ['login gagal sesaat → login ulang sebelum laporan', /login ulang berhasil sebelum laporan/.test(out3)],
    ['laporan menghitung SEMUA akun (bukan kurang)', /· (\d+)\/\1 akun masuk/.test(masuk3)],
    ['akun sehat tidak lagi dilabeli "token mati"', !/token mati/.test(out3)],
    ['notif "ikut berhasil" saat ada akun yang berhasil join', notifs.some((n) => String(n.title || '').includes('ikut berhasil'))],
    ['semua sudah ikut → judul "semua sudah ikut"', /semua sudah ikut/.test(title2)],
    ['nol kegagalan → TIDAK bilang "ada yang gagal"', !/ada yang gagal/.test(title2)],
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
    ['angpao menghitung bagian semua peserta', angCount >= 9 && angTotal === angCount * 4500],
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
