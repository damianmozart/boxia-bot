#!/usr/bin/env node
/*
 * analyze-participants.mjs — baca data PESERTA event yang sudah lewat, terus
 * tampilkan seberapa cepat kuotanya terisi. Dipakai buat nentukan waktu tembak
 * yang benar (lihat freeBoxDelayMs / earlyFireMs di README).
 *
 * Kenapa perlu: kuota angpao 100 slot ternyata habis di detik pertama, sedangkan
 * free box 70 slot baru penuh pelan-pelan — jadi keduanya butuh strategi beda.
 *
 * Pakai:
 *   node analyze-participants.mjs            — semua event hari ini yang sudah selesai
 *   node analyze-participants.mjs 275        — event #275 saja (hari ini + kemarin)
 *   node analyze-participants.mjs 275 --at 13:00
 *
 * Kolom output:
 *   detik      — detik ke berapa setelah event dibuka
 *   masuk      — berapa orang join di detik itu
 *   kumulatif  — total peserta s/d detik itu (= posisi kalau kamu join di detik itu)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BASE = 'https://api.boxkia.com/api/v2';
const token = (CFG.accounts || []).find((a) => a.token)?.token || CFG.token || '';
const TYPE = { 0: 'free-box', 1: 'angpao' };

const args = process.argv.slice(2);
const wantedId = args.find((a) => /^\d+$/.test(a)) ? Number(args.find((a) => /^\d+$/.test(a))) : null;
const atIdx = args.indexOf('--at');
const overrideStart = atIdx >= 0 ? args[atIdx + 1] : null;

const H = { 'Content-Type': 'application/json', token, lang: 'id', 'country-id': '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// join_date dari API formatnya 12 jam ("01:00:03 PM"), tapi argumen --at ditulis
// 24 jam ("13:00"). Kalau ada AM/PM → logika 12 jam, kalau tidak → 24 jam.
function clockToSec(s) {
  const m = String(s || '').match(/(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mer = (m[4] || '').toUpperCase();
  if (mer) { h %= 12; if (mer === 'PM') h += 12; }
  return h * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

async function fetchRecords(id, dateType) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    let r = null;
    try {
      r = await fetch(`${BASE}/activity/luckyBag/record?page=${page}&page_size=50&id=${id}&date_type=${dateType}`, { headers: H, signal: AbortSignal.timeout(15000) }).then((x) => x.json());
    } catch { break; }
    if (!r || r.code !== 0) { if (r && r.code === 10003) return { error: 'token tidak valid' }; break; }
    const list = r.data?.list || [];
    all.push(...list);
    if (list.length < 50) break;
    await sleep(150);
  }
  return { list: all };
}

function analyze(id, label, startSec, list) {
  const rows = list
    .map((x) => ({ pos: Number(x.sale_num) || 0, t: clockToSec(x.join_date) - startSec, win: x.is_win }))
    .filter((r) => Number.isFinite(r.t));
  if (!rows.length) return null;

  const buckets = new Map();
  for (const r of rows) {
    const b = Math.max(0, Math.floor(r.t));
    if (!buckets.has(b)) buckets.set(b, { n: 0, max: 0, min: Infinity });
    const x = buckets.get(b);
    x.n++; x.max = Math.max(x.max, r.pos); x.min = Math.min(x.min, r.pos);
  }

  const maxPos = Math.max(...rows.map((r) => r.pos));
  console.log(`\n=== ${label} #${id} — ${rows.length} peserta (posisi tertinggi ${maxPos}) ===`);
  console.log(' detik | masuk | kumulatif | posisi dapat');
  let cum = 0;
  const seconds = [...buckets.keys()].sort((a, b) => a - b);
  for (const s of seconds) {
    cum += buckets.get(s).n;
    console.log(`${String(s).padStart(6)} | ${String(buckets.get(s).n).padStart(5)} | ${String(cum).padStart(9)} | ${buckets.get(s).min}-${buckets.get(s).max}`);
    if (s >= 12 && cum >= maxPos) break;
  }
  // jawaban langsung: di detik ke berapa kumulatif nembus 20 dan 30
  const answer = (target) => {
    let c = 0;
    for (const s of seconds) { c += buckets.get(s).n; if (c >= target) return s; }
    return null;
  };
  const p20 = answer(20), p30 = answer(30), full = answer(maxPos);
  console.log(`→ posisi ke-20 tercapai di detik ~${p20}, ke-30 di detik ~${p30}, kuota penuh (${maxPos}) di detik ~${full}`);
  return { maxPos, p20, p30, full };
}

async function main() {
  if (!token) {
    console.log('⚠ Tidak ada token di config.json — endpoint peserta butuh login.');
    return;
  }

  let events = [];
  try {
    const r = await fetch(`${BASE}/activity/luckyBag/list`, { headers: H, signal: AbortSignal.timeout(15000) }).then((x) => x.json());
    events = r.data?.list || [];
  } catch { /* lanjut dengan id manual */ }

  let targets;
  if (wantedId) {
    const found = events.find((a) => a.id === wantedId);
    targets = [{
      id: wantedId,
      type: found ? found.type : null,
      start: overrideStart || found?.start_time || null,
    }];
    if (!targets[0].start) {
      console.log('⚠ Start time tidak diketahui — pakai --at HH:MM (mis. --at 13:00).');
      targets[0].start = overrideStart || '00:00';
    }
  } else {
    targets = events
      .filter((a) => a.is_progress === 2)
      .sort((a, b) => b.diff_time_start - a.diff_time_start)
      .map((a) => ({ id: a.id, type: a.type, start: a.start_time }));
    if (!targets.length) {
      console.log('Belum ada event yang selesai hari ini. Pakai: node analyze-participants.mjs <id> --at HH:MM');
      return;
    }
  }

  for (const t of targets) {
    const startSec = clockToSec(t.start);
    const label = `${TYPE[t.type] ?? 'event'} ${t.start}`;
    for (const dt of [0, 1]) {
      const res = await fetchRecords(t.id, dt);
      if (res.error) { console.log(`⚠ ${res.error}`); return; }
      const out = analyze(t.id, `${label}${dt === 1 ? ' (hari sebelumnya)' : ''}`, startSec, res.list || []);
      if (dt === 0 && !out) console.log(`\n=== ${label} #${t.id} — belum ada data peserta ===`);
    }
  }
}

main().catch((e) => { console.log('FATAL:', e?.message || e); process.exit(1); });
