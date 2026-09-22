#!/usr/bin/env node
/*
 * test-freebox-notify.mjs — regresi buat kebijakan notif Daily Free Blind Box.
 *
 * Server Boxkia kadang menahan satu koneksi sampai timeout. Karena pengecekan
 * box jalan tiap 5 menit (cron cloud) plus 15 menit (bot laptop), satu hiccup
 * sesaat dulu cukup buat mengirim "⚠️ Free Box: N error" ke HP — dan itu terjadi
 * belasan kali sehari. Tes ini menegaskan kebijakannya:
 *
 *   1. SEMUA target gagal (masalah nyata)        → HARUS kirim notif
 *   2. sebagian gagal karena jaringan, sisanya OK → TIDAK boleh kirim notif
 *
 * Notif diarahkan ke topic uji acak (bukan topic HP), lalu dibaca ulang dari
 * server ntfy — jadi yang diverifikasi benar-benar "pesan terkirim/tidak",
 * bukan sekadar asumsi dari kode.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 8096;
const TOPIC = `boxkia-test-${Math.random().toString(36).slice(2, 10)}`;
const TARGETS = ['West said', 'Femzy', 'Boxkia 27895', 'syawarman'];
// mode global untuk mock: 'all-fail' | 'mostly-ok' | 'flaky-once'
let mode = 'mostly-ok';
const seenOnce = new Set();   // token yang sudah pernah gagal sekali (mode flaky)

const notifs = [];   // pesan yang benar-benar dikirim (ditangkap mock ntfy lokal)

const CFG = JSON.parse(readFileSync(path.join(import.meta.dirname, 'config.json'), 'utf8'));
const byToken = new Map(
  (CFG.accounts || []).filter((a) => TARGETS.includes(a.name)).map((a, i) => [a.token, { name: a.name, ok: i < 3 }])
);

const JSON_H = { 'Content-Type': 'application/json' };

const server = http.createServer((req, res) => {
  // POST ke root = mock ntfy lokal, biar jumlah notif bisa dihitung pasti
  // (nggak bergantung ke jaringan/rate-limit ntfy.sh).
  if (req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { notifs.push(JSON.parse(b)); } catch { notifs.push({ title: b }); }
      res.writeHead(200, JSON_H).end('{}');
    });
    return;
  }
  const tok = req.headers.token || 'none';
  const acct = byToken.get(tok);
  req.resume();
  req.on('end', () => {
    if (!acct) return res.writeHead(200, JSON_H).end(JSON.stringify({ code: 0, data: { free_blind_box_info: null } }));
    // gagal jaringan: putuskan koneksi tanpa balasan (mirip timeout/fetch failed)
    if (mode === 'all-fail' || (mode === 'mostly-ok' && !acct.ok)) { req.socket.destroy(); return; }
    // flaky: request PERTAMA tiap akun diputus, berikutnya normal — meniru
    // hiccup sesaat yang seharusnya selesai dengan satu retry.
    if (mode === 'flaky-once' && !seenOnce.has(tok)) { seenOnce.add(tok); req.socket.destroy(); return; }
    return res.writeHead(200, JSON_H).end(JSON.stringify({
      code: 0, msg: 'ok',
      data: { free_blind_box_info: { status: 2, level: 2, next_time_unix: 3600000 } },
    }));
  });
});

function runBot() {
  return new Promise((resolve) => {
    const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'boxkia-fbnotif-'));
    const p = spawn(process.execPath, ['freebox-draw.mjs'], {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        BOXKIA_FREEBOX_API_BASE: `http://127.0.0.1:${PORT}`,
        BOXKIA_NTFY_TOPIC: TOPIC,
        BOXKIA_NTFY_URL: `http://127.0.0.1:${PORT}/`,
        DATA_DIR,
      },
    });
    let out = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      clearTimeout(t);
      try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* abaikan */ }
      resolve(out);
    });
  });
}

const countNotifs = () => notifs.length;

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`mock API di :${PORT}, topic uji: ${TOPIC}\n`);

  console.log('--- kasus 1: satu akun gagal jaringan, tiga akun normal ---');
  mode = 'mostly-ok';
  const out1 = await runBot();
  console.log(out1.split('\n').filter((l) => /Free Box|❌|⏳|notif/.test(l)).join('\n'));
  const n1 = countNotifs();
  console.log(`  → notif terkirim: ${n1}\n`);

  console.log('--- kasus 2: gagal sekali (hiccup), retry menyelamatkan ---');
  mode = 'flaky-once';
  const out1b = await runBot();
  console.log(out1b.split('\n').filter((l) => /Free Box|❌|⏳|✅|notif/.test(l)).join('\n'));
  const n1b = countNotifs();
  console.log(`  → notif terkirim: ${n1b}\n`);

  console.log('--- kasus 3: SEMUA akun gagal (koneksi ngadat, bukan botnya rusak) ---');
  mode = 'all-fail';
  const out2 = await runBot();
  console.log(out2.split('\n').filter((l) => /Free Box|❌|notif/.test(l)).join('\n'));
  const n2 = countNotifs();
  console.log(`  → notif terkirim: ${n2} — ${notifs.map((m) => m.title).join(' | ')}\n`);

  const checks = [
    ['sebagian gagal (jaringan) → TIDAK spam notif', n1 === 0],
    ['log menyebut notif dilewati', /notif dilewati biar HP nggak spam/.test(out1)],
    ['hiccup sesaat selesai dengan retry (nggak ada error tersisa)', n1b === 0 && !/❌/.test(out1b)],
    ['retry menyelamatkan → akun tetap terbaca', /sudah draw/.test(out1b)],
    ['semua gagal → tetap dinotifikasi', n2 > 0],
    ['semua gagal karena jaringan → judul jujur menyebut jaringan', /🌐 Free Box: gangguan jaringan \(\d+ akun\)/.test(out2)],
    ['detailnya menegaskan box tidak hilang (dicoba lagi)', /dicoba lagi otomatis, box tidak hilang/.test(out2)],
  ];

  console.log('=== hasil verifikasi ===');
  let bad = 0;
  for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? '✅' : '❌'} ${name}`); }
  console.log(bad ? `\n❌ ${bad} check gagal` : '\n✅ SEMUA CHECK LULUS');
  server.closeAllConnections?.();
  server.close();
  process.exit(bad ? 1 : 0);
});
