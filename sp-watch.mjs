#!/usr/bin/env node
/*
 * sp-watch.mjs — monitor terpisah untuk barang SP (高爆赏 / 保底赏 / 魔王赏).
 *
 * Tiap barang punya histori undian:
 *   - "roll tanpa SP" = jumlah roll sejak SP terakhir keluar (sales_num_sp)
 *   - "avg rolls"     = rata-rata roll antar SP dari ~20 SP terakhir
 *                       (dataAnalysis/sp → average_info.sale_num_total)
 *
 * Kalau "roll tanpa SP" sudah MENDekati rata-rata (spApproachPct, default 80%),
 * tool ini langsung kirim notif ⚠️ ke ntfy. Kalau sudah MELEWATI rata-rata
 * (100%+), naik ke notif 🔥. Begitu SP-nya keluar & gap reset, kirim notif ✅.
 *
 * Zero dependency: Node 18+ (fetch bawaan). Baca config.json yang sama dengan
 * bot (apiBase, ntfyTopic, token akun pertama).
 *
 * Mode:
 *   node sp-watch.mjs           — watch terus-menerus (biarkan jalan)
 *   node sp-watch.mjs --once    — scan sekali, notif status sekarang, keluar
 *   node sp-watch.mjs --reset   — hapus state (biar notif ulang dari awal)
 *
 * Config tambahan (opsional, di config.json):
 *   "spWatchIntervalMs": 300000   — jeda scan (default 5 menit)
 *   "spApproachPct": 80           — % dari avg untuk trigger notif ⚠️
 */

import { readFileSync, writeFileSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = {
  token: '', countryId: '', visitorId: 'boxkia-bot', lang: 'id',
  ntfyTopic: '',
  spWatchIntervalMs: 300000,
  spApproachPct: 80,
  ...JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8')),
};

const BASE = (CFG.apiBase || 'https://api.boxkia.com/api/v2').replace(/\/$/, '');
const acct = (Array.isArray(CFG.accounts) && CFG.accounts[0]) || CFG;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// DATA_DIR (env) bisa diarahkan ke volume persistent — dipakai di Fly.io biar
// log & state nggak hilang tiap redeploy. Default: folder yang sama dengan kode.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'sp-watch-state.json');
const LOG_FILE = path.join(DATA_DIR, 'sp-watch.log');
const SP_TABS = [163, 98, 99]; // 163=高爆赏, 98=保底赏, 99=魔王赏 (101=PK tidak punya data SP)

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const PITY = args.has('--pity');
const NOTIFY = args.has('--notify');
const INTERVAL = Number(CFG.spWatchIntervalMs) || 300000;
const APPROACH_PCT = Number(CFG.spApproachPct) || 80;
// spZones: notif zona beli per barang — { name, min, deep }.
//   min  = counter masuk zona beli (notif 🟡)
//   deep = counter lewat p90 / zona ekstrem (notif 🔴)
const ZONES = Array.isArray(CFG.spZones) ? CFG.spZones : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...parts) {
  const line = `[${new Date().toLocaleString('id-ID')}] ${parts.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* abaikan */ }
}

async function ntfy(title, msg) {
  if (!CFG.ntfyTopic) { log('⚠ ntfyTopic kosong — notif tidak dikirim.'); return; }
  try {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: CFG.ntfyTopic, title, message: msg }),
    });
    if (!res.ok) log(`⚠ ntfy gagal: HTTP ${res.status} (${title})`);
  } catch (e) {
    log(`⚠ ntfy gagal: ${e?.message || e} (${title})`);
  }
}

async function api(p, { method = 'POST', params, data } = {}) {
  const url = new URL(BASE + p);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      token: acct.token || '',
      lang: acct.lang || 'id',
      'country-id': acct.countryId || '',
      'X-Device-VisitorId': acct.visitorId || 'boxkia-bot',
      'User-Agent': UA,
    },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

/* ---------------- data ---------------- */

async function spItemList() {
  const items = [];
  for (const tab of SP_TABS) {
    let page = 1;
    for (;;) {
      const r = await api('/home/list', { data: { blind_box_type: tab, page, page_size: 50 } }).catch(() => null);
      const list = r?.data?.figure_list || [];
      items.push(...list.map((x) => ({ id: x.id, name: x.name || `#${x.id}`, price: Number(x.sell_price || 0) })));
      if (list.length < 50) break;
      page++;
    }
  }
  return items;
}

async function fetchSpStatus(it) {
  const [g, ts, ta] = await Promise.all([
    api('/goods/guaranteeDetail', { data: { id: it.id } }).catch(() => null),
    api('/goods/dataAnalysis/sp', { data: { id: it.id, mode_type: 0, type: 0 } }).catch(() => null),
    api('/goods/dataAnalysis/sp', { data: { id: it.id, mode_type: 0, type: 1 } }).catch(() => null),
  ]);
  const info = g?.data?.info;
  if (!info || info.sales_num_sp == null) return null; // barang tanpa data SP / off sale
  // histori SP terakhir: tiap entri = roll ke berapa SP keluar saat itu (pity per kejadian)
  const hist = (ts?.data?.list || [])
    .map((x) => Number(x.sale_num_total || 0))
    .filter((n) => n > 0);
  return {
    id: String(it.id), // string biar konsisten dengan key JSON state file
    name: it.name,
    price: it.price,
    gapSp: Number(info.sales_num_sp || 0),
    avgSp: Number(ts?.data?.average_info?.sale_num_total || 0),
    gapA: Number(info.sales_num_a || 0),
    avgA: Number(ta?.data?.average_info?.sale_num_total || 0),
    hist,
  };
}

/* ---------------- pity board ---------------- */

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function pityBoard(statuses) {
  const rows = statuses
    .filter((s) => s.avgSp > 0) // butuh data rata-rata biar pity-nya bermakna
    .map((s) => {
      const pct = Math.round((s.gapSp / s.avgSp) * 100);
      const icon = pct >= 100 ? '🔥' : pct >= APPROACH_PCT ? '⚠️' : '✅';
      return {
        ...s,
        pct,
        icon,
        sisa: s.avgSp - s.gapSp, // perkiraan sisa roll sampai rata-rata (minus = sudah lewat)
        med: median(s.hist),
        min: s.hist.length ? Math.min(...s.hist) : 0,
        max: s.hist.length ? Math.max(...s.hist) : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct); // paling dekat jatuh tempo di atas

  const L = [];
  L.push('📊 PITY BOARD — SP (高爆赏)');
  L.push('Barang'.padEnd(30) + 'pity'.padStart(6) + 'rata2'.padStart(7) + 'med'.padStart(6) + 'min'.padStart(6) + 'max'.padStart(6) + '%avg'.padStart(6) + 'sisa'.padStart(6));
  for (const r of rows) {
    const name = r.name.length > 28 ? r.name.slice(0, 27) + '…' : r.name;
    L.push(name.padEnd(30)
      + String(r.gapSp).padStart(6)
      + String(r.avgSp).padStart(7)
      + String(r.med).padStart(6)
      + String(r.min).padStart(6)
      + String(r.max).padStart(6)
      + String(r.pct).padStart(5) + '%'
      + String(r.sisa).padStart(6)
      + ' ' + r.icon);
  }
  const due = rows.filter((r) => r.pct >= 100).length;
  const appr = rows.filter((r) => r.pct >= APPROACH_PCT && r.pct < 100).length;
  L.push(`— ${rows.length} barang dengan data | 🔥 ${due} jatuh tempo | ⚠️ ${appr} mendekati | kolom: pity=roll sejak SP terakhir, rata2/med/min/max=statistik histori SP, %avg=progress vs rata-rata, sisa=roll tersisa sampai rata-rata`);
  return L.join('\n');
}

async function pityMode() {
  const statuses = await scanOnce();
  const board = pityBoard(statuses);
  log(board);
  if (NOTIFY) await ntfy('📊 Boxkia: Pity Board SP', board);
}

// status item: 'ok' | 'approach' (>= spApproachPct% dari avg) | 'due' (>= 100%)
function stateOf(s) {
  if (s.avgSp <= 0) return 'ok';
  const pct = (s.gapSp / s.avgSp) * 100;
  if (pct >= 100) return 'due';
  if (pct >= APPROACH_PCT) return 'approach';
  return 'ok';
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(s) {
  try { mkdirSync(path.dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { log('⚠ gagal simpan state:', e?.message || e); }
}

async function scanOnce() {
  const items = await spItemList();
  const statuses = (await Promise.all(items.map(fetchSpStatus))).filter(Boolean);
  statuses.sort((a, b) => stateOf(b) === stateOf(a) ? (b.gapSp / Math.max(b.avgSp, 1) - a.gapSp / Math.max(a.avgSp, 1)) : (stateOf(b) === 'due' ? 1 : stateOf(b) === 'approach' ? 0 : -1) - (stateOf(a) === 'due' ? 1 : stateOf(a) === 'approach' ? 0 : -1));
  return statuses;
}

/* Notif zona beli: pas counter barang masuk zona (min) atau lewat deep (p90).
 * Dedup via state.zones[id] = level (0=none, 1=zona, 2=ekstrem). Reset otomatis
 * pas counter turun lagi (SP keluar / reset). */
async function checkZones(statuses, state) {
  if (!ZONES.length) return;
  if (!state.zones) state.zones = {};
  for (const z of ZONES) {
    const s = statuses.find((x) => x.name.toLowerCase().includes(String(z.name).toLowerCase()));
    if (!s) continue;
    const prev = state.zones[s.id] || 0;
    let lvl = 0;
    if (s.gapSp >= (z.deep || Infinity)) lvl = 2;
    else if (s.gapSp >= (z.min || Infinity)) lvl = 1;
    if (lvl === prev) continue;
    state.zones[s.id] = lvl;
    if (lvl === 1) {
      await ntfy('🟡 Boxkia: masuk zona beli', `${s.name} — counter ${s.gapSp} roll, masuk zona beli (≥${z.min}).${z.deep ? ` Zona ekstrem di ${z.deep} (90% kasus historis).` : ''} Siap-siap beli! (Rp ${Number(s.price).toLocaleString('id-ID')}/roll)`);
      log(`🟡 [${s.name}] masuk zona beli — ${s.gapSp}/${z.min}`);
    } else if (lvl === 2) {
      await ntfy('🔴 Boxkia: zona ekstrem', `${s.name} — counter ${s.gapSp} roll, sudah melewati ${z.deep} (90% kasus historis jatuh sebelum ini). Waktu paling kritis, jangan tunggu lama! (Rp ${Number(s.price).toLocaleString('id-ID')}/roll)`);
      log(`🔴 [${s.name}] zona ekstrem — ${s.gapSp}/${z.deep}`);
    } else {
      log(`↩️ [${s.name}] counter reset ke ${s.gapSp} — siap deteksi ulang`);
    }
  }
}

async function watch() {
  if (args.has('--reset')) {
    try { rmSync(STATE_FILE); log('🧹 State direset — notif akan mulai dari awal.'); } catch { /* belum ada file */ }
  }

  let state = loadState();
  let firstRun = Object.keys(state).length === 0;

  for (;;) {
    try {
      const statuses = await scanOnce();
      const ids = new Set(statuses.map((s) => s.id));

      // bersihkan state untuk barang yang sudah tidak ada di daftar (off sale)
      for (const id of Object.keys(state)) if (id !== 'zones' && !ids.has(id)) delete state[id];
      if (state.zones) for (const id of Object.keys(state.zones)) if (!ids.has(id)) delete state.zones[id];

      const now = new Date().toLocaleString('id-ID');
      const dueList = statuses.filter((s) => stateOf(s) === 'due');
      const approachList = statuses.filter((s) => stateOf(s) === 'approach');

      for (const s of statuses) {
        const st = stateOf(s);
        const prev = state[s.id] || 'ok';
        if (st === prev) continue;
        state[s.id] = st;
        if (st === 'approach') {
          const pct = Math.round((s.gapSp / s.avgSp) * 100);
          await ntfy('⚠️ Boxkia: SP mendekati', `${s.name} — roll tanpa SP ${s.gapSp} sudah ${pct}% dari rata-rata ${s.avgSp}. Sebentar lagi jatuh tempo! (Rp ${Number(s.price).toLocaleString('id-ID')}/roll)`);
          log(`⚠️ [${s.name}] SP mendekati — ${s.gapSp}/${s.avgSp} (${pct}%)`);
        } else if (st === 'due') {
          const pct = Math.round((s.gapSp / s.avgSp) * 100);
          await ntfy('🔥 Boxkia: SP jatuh tempo', `${s.name} — roll tanpa SP ${s.gapSp} sudah MELEWATI rata-rata ${s.avgSp} (${pct}%). Chance SP naik signifikan! (Rp ${Number(s.price).toLocaleString('id-ID')}/roll)`);
          log(`🔥 [${s.name}] SP jatuh tempo — ${s.gapSp}/${s.avgSp} (${pct}%)`);
        } else if (prev !== 'ok' && st === 'ok') {
          await ntfy('✅ Boxkia: SP keluar (reset)', `${s.name} — gap reset ke ${s.gapSp} roll. SP baru saja keluar.`);
          log(`✅ [${s.name}] SP keluar — gap reset ke ${s.gapSp}`);
        }
      }
      await checkZones(statuses, state);
      saveState(state);

      const line = `🔍 scan ${now} — ${statuses.length} barang | 🔥 ${dueList.length} jatuh tempo | ⚠️ ${approachList.length} mendekati`;
      log(line);
      if (dueList.length) log('  🔥', dueList.map((s) => s.name).join(', '));
      if (approachList.length) log('  ⚠️', approachList.map((s) => s.name).join(', '));
      if (firstRun) {
        log('ℹ️ Ini scan pertama (state kosong) — status di atas sudah dinotifikasi.');
        firstRun = false;
      }

      if (ONCE) return;
      await sleep(INTERVAL);
    } catch (e) {
      log('⚠ error:', e?.message || e);
      if (ONCE) return;
      await sleep(INTERVAL);
    }
  }
}

if (PITY) {
  pityMode().catch((e) => log('⚠ error pity:', e?.message || e));
} else {
  watch();
}
