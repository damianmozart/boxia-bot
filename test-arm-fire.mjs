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

const PORT = 8099;
const T0 = Date.now() + 6000;
const log = [];
let listCalls = [];
const joinFirstAt = new Map();

const JSON_H = { 'Content-Type': 'application/json' };

function schedule() {
  return {
    code: 0,
    msg: 'ok',
    data: {
      activity_info: { user_spend_amount: '0.00' },
      list: [{
        id: 999, type: 1, start_time: 'MOCK 01:00 PM', is_progress: 0, is_join: 0,
        join_total: 0, join_user_limit: 100, limit_price: 0, level_limit: 0,
        diff_time_start: Math.max(0, T0 - Date.now()),
      }],
    },
  };
}

const bucketByToken = new Map();
function joinResult(token) {
  if (Date.now() < T0) return { code: 1, msg: 'not started yet' };
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
      if (!joinFirstAt.has(tok)) joinFirstAt.set(tok, Date.now());
      return res.writeHead(200, JSON_H).end(JSON.stringify(joinResult(tok)));
    }
    if (url.includes('/activity/luckyBag/record')) {
      return res.writeHead(200, JSON_H).end(JSON.stringify({ code: 0, data: { list: [] } }));
    }
    if (url.includes('/user/info')) {
      if (!bucketByToken.has(tok)) bucketByToken.set(tok, bucketByToken.size % 3);
      const i = [...bucketByToken.keys()].indexOf(tok);
      return res.writeHead(200, JSON_H).end(JSON.stringify({
        code: 0, msg: 'ok',
        data: { nickname: `mock${i}`, user_id: 1000 + i, user_level: 9, balance: '1000', integral: '5' },
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
        ACTIONS_BUDGET_MS: '60000',
      },
    });
    let out = '';
    const deadline = setTimeout(() => p.kill('SIGKILL'), 45000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => { clearTimeout(deadline); resolve(out); });
  });
}

server.listen(PORT, '127.0.0.1', async () => {
  log.push(`mock nyala di :${PORT} — T0 dalam 6s`);
  const out = await run();
  console.log(out);

  const head = out.split('\n').filter((l) => /arm|tembak|📣|nembak|keluar/.test(l));
  console.log('\n=== ringkasan log bot ===');
  console.log(head.join('\n'));

  const fired = [...joinFirstAt.values()];
  const firstJoin = fired.length ? Math.min(...fired) : null;
  // jendela kritis = sebelum & saat tembakan (setelah burst, request list lagi itu wajar)
  const critStart = T0 - 1000, critEnd = T0 + 150;
  const listInCritical = listCalls.filter((t) => t >= critStart && t <= critEnd).length;
  const lastListBefore = listCalls.filter((t) => t < critStart).length;

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
  ];
  console.log('\n=== hasil verifikasi ===');
  let bad = 0;
  for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? '✅' : '❌'} ${name}`); }
  console.log(`\nlist calls total: ${listCalls.length} (sebelum jendela kritis: ${lastListBefore}, di dalam: ${listInCritical})`);
  console.log(`offset list calls vs T0: ${listCalls.map((t) => t - T0).join(', ')}`);
  console.log(`offset join pertama vs T0: ${[...joinFirstAt.entries()].map(([k, v]) => `${k.slice(0, 6)}=${v - T0}`).join(', ')}`);
  console.log(`T0-relative join pertama: ${firstJoin == null ? 'n/a' : (firstJoin - T0) + 'ms'}`);
  console.log(bad ? `\n❌ ${bad} check gagal` : '\n✅ SEMUA CHECK LULUS');
  server.close();
  process.exit(bad ? 1 : 0);
});
