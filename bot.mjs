#!/usr/bin/env node
/*
 * boxkia-bot — bot otomatis untuk event Treasure Hunt Boxkia
 * (https://boxkia.com/treasureHunt) — angpao (type 1) & free box (type 0).
 * Mendukung MULTI-AKUN: tiap akun pakai token sendiri, join paralel.
 *
 * Cara kerja:
 *   1. Polling GET  /activity/luckyBag/list  per akun (jadwal + is_join + spend per akun)
 *   2. Pantau countdown (diff_time_start) tiap event target
 *   3. Tepat saat mulai (atau beberapa ms sebelum, lihat earlyFireMs),
 *      tembak POST /activity/luckyBag/join  {id}  berulang-ulang (burst)
 *      sampai sukses (code==0) atau batas waktu retryMaxMs habis.
 *
 * Token login di config.json — cara ambilnya ada di README.md.
 * Zero dependency: Node 18+ (pakai fetch bawaan).
 *
 * Mode:
 *   node bot.mjs              — loop terus-menerus (biarkan jalan)
 *   node bot.mjs --check      — cek token + tampilkan jadwal hari ini, lalu keluar
 *   node bot.mjs --once       — satu kali polling, lalu keluar
 *   node bot.mjs --dry-run    — jangan benar-benar join (hanya simulasi)
 *   node bot.mjs --saldo      — tampilkan saldo & poin tiap akun, lalu keluar
 *   node bot.mjs --sp         — scan barang SP & cek "roll tanpa SP" vs "avg rolls" (due checker)
 *   node bot.mjs --jadwal     — kirim ringkasan jadwal hari ini + akun yang bisa ikut ke ntfy
 *   node bot.mjs --actions    — mode GitHub Actions (single-shot): kalau ada event mulai
 *                                <= 6 menit lagi, tidur sampai fast window lalu burst join
 *
 * Config tambahan:
 *   dailyScheduleHour — jam (0-23) kirim ringkasan jadwal harian ke ntfy sekali sehari (0 = tengah malam)
 */

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = {
  token: '', countryId: '', visitorId: 'boxkia-bot', lang: 'id',
  accounts: [],
  targetType: 'all',           // 1 = angpao, 0 = free box, 'all' = keduanya
  pollIntervalMs: 2000,        // polling normal
  fastPollIntervalMs: 250,     // polling cepat saat event mendekati mulai
  fastWindowMs: 30000,         // mulai polling cepat X ms sebelum mulai
  earlyFireMs: 400,            // tembak join X ms SEBELUM waktu mulai
  retryIntervalMs: 120,        // jeda antar tembakan di dalam burst
  retryMaxMs: 8000,            // durasi maksimal burst
  apiTimeoutMs: 15000,         // timeout tiap request API — cegah fetch macet membekukan bot
  ntfyTopic: '',
  ...JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8')),
};

const BASE = (CFG.apiBase || 'https://api.boxkia.com/api/v2').replace(/\/$/, '');
const TYPE_NAME = { 0: 'free-box', 1: 'angpao' };
const TYPE_LABEL = { 0: 'Free Box (gratis, syarat level)', 1: 'Angpao / red envelope' };
// DATA_DIR (env) bisa diarahkan ke volume persistent — dipakai di Fly.io biar
// log & state nggak hilang tiap redeploy. Default: folder yang sama dengan kode.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOG_FILE = path.join(DATA_DIR, 'boxkia-bot.log');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- akun ---------------- */

function parseAccounts() {
  const out = [];
  const push = (a, i) => {
    if (!a || !a.token) return;
    out.push({
      key: `akun${i}`,
      token: a.token,
      countryId: a.countryId || '',
      visitorId: a.visitorId || `boxkia-bot-${i}`,
      lang: a.lang || CFG.lang || 'id',
      name: a.name || `akun${i}`,
    });
  };
  if (Array.isArray(CFG.accounts) && CFG.accounts.length) {
    CFG.accounts.forEach(push);
  } else {
    push({ token: CFG.token, countryId: CFG.countryId, visitorId: CFG.visitorId, name: 'main' }, 1);
  }
  return out;
}

const ACCOUNTS = parseAccounts();
const users = new Map();     // key -> userInfo
const spends = new Map();    // key -> user_spend_amount hari ini
const attempted = new Map(); // key -> Set(eventId)
const joined = new Map();    // key -> Set(eventId)
const attemptedAny = new Set(); // event id yang pernah ditembak/diikuti (lintas akun)
const reported = new Set();     // event id yang hasil undiannya sudah dilaporkan

/* ---------------- util ---------------- */

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
    });
    if (!res.ok) log(`⚠ ntfy gagal: HTTP ${res.status} (${title})`);
  } catch (e) {
    log(`⚠ ntfy gagal: ${e?.message || e} (${title})`);
  }
}

async function api(p, { account, method = 'GET', params, data } = {}) {
  const a = account || CFG;
  const url = new URL(BASE + p);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      token: a.token || '',
      lang: a.lang || 'id',
      'country-id': a.countryId || '',
      'X-Device-VisitorId': a.visitorId || 'boxkia-bot',
      'User-Agent': UA,
    },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(CFG.apiTimeoutMs),
  });
  return res.json();
}

function targetMatch(a) {
  if (CFG.targetType === 'all') return true;
  return a.type === Number(CFG.targetType);
}

// null = boleh dicoba; string = alasan tidak memenuhi syarat (skip)
function ineligibleReason(a, spend, user) {
  if (a.type === 0 && user && user.user_level < (a.level_limit || 0)) {
    return `level ${user.user_level} < LV${a.level_limit}`;
  }
  if (a.type === 1 && user && (spend ?? 0) < (a.limit_price || 0)) {
    return `belanja hari ini ${spend} < ${a.limit_price}`;
  }
  return null;
}

function statusLabel(a) {
  if (a.is_progress === 0) return 'belum mulai';
  if (a.is_progress === 1) return a.is_join == 1 ? 'ikut ✓' : 'BERJALAN';
  return 'selesai';
}

function localTime(msFromNow) {
  return new Date(Date.now() + msFromNow).toLocaleString('id-ID');
}

/* ---------------- data ---------------- */

async function fetchUserInfo(acct) {
  const r = await api('/user/info', { account: acct, method: 'POST', data: {} });
  return r.code === 0 ? r.data : null;
}

async function loadSchedule(acct) {
  const r = await api('/activity/luckyBag/list', { account: acct });
  if (r.code !== 0) throw new Error(`list gagal: code=${r.code} msg=${r.msg}`);
  return r.data;
}

/* ---------------- display ---------------- */

function printSchedule(list) {
  log(`— jadwal (${list.length} event) —`);
  const shown = list
    .filter((a) => a.is_progress !== 2)
    .sort((a, b) => a.diff_time_start - b.diff_time_start)
    .slice(0, 8);
  for (const a of shown) {
    const t = TYPE_NAME[a.type] || `type${a.type}`;
    const start = a.is_progress === 0 ? localTime(a.diff_time_start) : 'sedang jalan';
    const elig = ACCOUNTS.map((ac) => {
      const why = ineligibleReason(a, spends.get(ac.key) ?? 0, users.get(ac.key));
      return `${ac.name}:${why ? '✗' : '✓'}`;
    }).join(' ');
    log(`  ${t.padEnd(8)} #${String(a.id).padEnd(4)} ${String(a.start_time).padEnd(11)} → ${start}  [${statusLabel(a)}] quota ${a.join_total}/${a.join_user_limit}  elig ${elig}`);
  }
}

/* ---------------- aksi utama ---------------- */

async function joinBurst(a, acct, spend) {
  const att = attempted.get(acct.key);
  if (att.has(a.id)) return;
  att.add(a.id);
  attemptedAny.add(a.id);
  const name = TYPE_NAME[a.type] || `type${a.type}`;
  log(`⚡ [${acct.name}] FIRING ${name} #${a.id} (mulai ${a.start_time}) — burst ${CFG.retryMaxMs}ms`);
  const deadline = Date.now() + CFG.retryMaxMs;
  let last = '';
  while (Date.now() < deadline) {
    if (DRY) {
      log(`  [dry-run] ${acct.name} akan join #${a.id} — tidak benar-benar dikirim`);
      return;
    }
    try {
      const r = await api('/activity/luckyBag/join', { account: acct, method: 'POST', data: { id: a.id } });
      if (r.code === 0) {
        joined.get(acct.key).add(a.id);
        const msg = `✅ [${acct.name}] BERHASIL ikut ${name} #${a.id} (${a.start_time}) — undian saat penuh`;
        log(msg);
        await ntfy('Boxkia: ikut berhasil', msg);
        return;
      }
      if (r.code === 10003) {
        log(`  ⛔ [${acct.name}] Login required — token salah/kosong. Isi config.json (lihat README).`);
        return;
      }
      last = `${r.code} ${r.msg || ''}`.trim();
    } catch (e) {
      last = String(e?.message || e);
    }
    await sleep(CFG.retryIntervalMs);
  }
  log(`  ⏹ [${acct.name}] ${name} #${a.id} — tidak berhasil dalam ${CFG.retryMaxMs}ms. Pesan terakhir: ${last}`);
  await ntfy('Boxkia: join gagal', `[${acct.name}] ${name} #${a.id} (${a.start_time})\n${last}`);
}

/* ---------------- laporan hasil undian ---------------- */

async function reportResult(a) {
  // kumpulkan record dari hari ini (0) dan kemarin (1), dedup by id
  const all = [];
  const seen = new Set();
  for (const dt of [0, 1]) {
    let page = 1;
    while (page <= 5) {
      const r = await api('/activity/luckyBag/record', { params: { page, page_size: 50, id: a.id, date_type: dt } }).catch(() => null);
      if (!r || r.code !== 0 || !r.data) break;
      const list = r.data.list || [];
      for (const rec of list) {
        if (!seen.has(rec.id)) { seen.add(rec.id); all.push(rec); }
      }
      if (list.length < 50 || (r.data.count && all.length >= r.data.count)) break;
      page++;
    }
    if (all.length) break;
  }
  if (!all.length) return false; // record belum terisi — coba lagi nanti
  reported.add(a.id);

  const rupiah = (v) => Number(v || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines = ACCOUNTS.map((acct) => {
    const u = users.get(acct.key);
    if (!u) return null;
    const rec = all.find((x) => x.user_id == u.user_id);
    if (!rec) return `• ${acct.name}: tidak ikut`;
    const win = rec.is_win == 1 ? ' 🏆' : '';
    const amount = rec.amount ? ` — Rp ${rupiah(rec.amount)}` : '';
    return `• ${acct.name}: IKUT — #${rec.sale_num}${amount}${win}`;
  }).filter(Boolean);

  const msg = `📊 Hasil ${TYPE_NAME[a.type]} #${a.id} (${a.start_time}) — ${all.length} peserta\n${lines.join('\n')}`;
  log(msg);
  await ntfy('Boxkia: hasil undian', msg);
  return true;
}

/* ---------------- laporan saldo ---------------- */

async function reportBalances(title = '💰 Boxkia: saldo') {
  // refresh user/info semua akun (sekalian update level/spend buat cek syarat)
  const rows = await Promise.all(ACCOUNTS.map(async (acct) => {
    const u = await fetchUserInfo(acct).catch(() => null);
    if (u) users.set(acct.key, u);
    if (!u) return `• ${acct.name}: gagal ambil data`;
    const rupiah = (v) => Number(v || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bal = rupiah(u.balance);
    const int = rupiah(u.integral);
    return `• ${acct.name} (LV${u.user_level}): Rp ${bal} | ${int} poin`;
  }));
  const msg = `💰 Saldo ${ACCOUNTS.length} akun — ${new Date().toLocaleString('id-ID')}\n${rows.join('\n')}`;
  log(msg);
  await ntfy(title, msg);
}

/* ---------------- laporan jadwal harian ---------------- */

const DAILY_STATE = path.join(DATA_DIR, 'daily-schedule-state.json');

function loadDailyState() {
  try { return JSON.parse(readFileSync(DAILY_STATE, 'utf8')); } catch { return {}; }
}
function saveDailyState(s) {
  try { mkdirSync(path.dirname(DAILY_STATE), { recursive: true }); writeFileSync(DAILY_STATE, JSON.stringify(s, null, 2)); } catch { /* abaikan */ }
}

// daftar event yang laporan hasilnya sudah dikirim (dipakai mode Actions biar nggak spam)
const REPORTED_FILE = path.join(DATA_DIR, 'reported-events.json');
function loadReported() {
  try { return new Set(JSON.parse(readFileSync(REPORTED_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveReported(s) {
  try { mkdirSync(path.dirname(REPORTED_FILE), { recursive: true }); writeFileSync(REPORTED_FILE, JSON.stringify([...s])); } catch { /* abaikan */ }
}

async function reportDailySchedule() {
  // fetch jadwal semua akun paralel (sekaligus refresh spend per akun)
  const results = await Promise.all(ACCOUNTS.map(async (acct) => {
    try { return { acct, data: await loadSchedule(acct) }; }
    catch (e) { log(`⚠ [${acct.name}] error fetch list (jadwal harian): ${e?.message || e}`); return null; }
  }));
  const first = results.find((r) => r && r.data);
  if (!first) { log('⚠ jadwal harian gagal: tidak ada data jadwal'); return false; }
  for (const r of results) {
    if (r) spends.set(r.acct.key, r.data.activity_info?.user_spend_amount ?? 0);
  }
  const list = (first.data.list || [])
    .filter((a) => targetMatch(a) && a.is_progress !== 2)
    .sort((a, b) => a.diff_time_start - b.diff_time_start);
  const lines = [`📅 Jadwal hari ini — ${new Date().toLocaleDateString('id-ID')}`];
  for (const a of list) {
    const syarat = a.type === 0 ? `LV${a.level_limit || 0}` : (a.limit_price ? `belanja ${a.limit_price}` : '');
    const elig = ACCOUNTS
      .filter((acct) => !ineligibleReason(a, spends.get(acct.key) ?? 0, users.get(acct.key)))
      .map((acct) => acct.name);
    const who = elig.length === 0 ? '—' : elig.length === ACCOUNTS.length ? 'semua akun ✓' : elig.join(', ');
    lines.push(`${a.start_time} ${TYPE_NAME[a.type]} #${a.id}${syarat ? ` (${syarat})` : ''} — ${who}`);
  }
  const msg = lines.join('\n');
  log(msg);
  await ntfy('📅 Boxkia: jadwal hari ini', msg);
  return true;
}

/* ---------------- scanner SP (roll tanpa SP vs avg rolls) ---------------- */
// Strategi: tiap barang punya histori "roll tanpa SP" (sales_num_sp) dan rata-rata
// roll antar SP (avg dari /goods/dataAnalysis/sp). Kalau sales_num_sp sudah melewati
// avg-nya, SP "jatuh tempo" — chance dapat SP naik signifikan.

const SP_TABS = [163, 98, 99]; // 163=高爆赏, 98=保底赏, 99=魔王赏 (101=PK tidak punya data SP)

async function spItemList() {
  const items = [];
  for (const tab of SP_TABS) {
    let page = 1;
    for (;;) {
      const r = await api('/home/list', { account: ACCOUNTS[0], method: 'POST', data: { blind_box_type: tab, page, page_size: 50 } }).catch(() => null);
      const list = r?.data?.figure_list || [];
      items.push(...list.map((x) => ({ id: x.id, name: x.name || `#${x.id}`, price: Number(x.sell_price || 0) })));
      if (list.length < 50) break;
      page++;
    }
  }
  return items;
}

// status SP satu barang: gap (roll tanpa SP) vs avg roll antar SP
async function fetchSpStatus(it) {
  const acct = ACCOUNTS[0];
  const [g, ts, ta] = await Promise.all([
    api('/goods/guaranteeDetail', { account: acct, method: 'POST', data: { id: it.id } }).catch(() => null),
    api('/goods/dataAnalysis/sp', { account: acct, method: 'POST', data: { id: it.id, mode_type: 0, type: 0 } }).catch(() => null),
    api('/goods/dataAnalysis/sp', { account: acct, method: 'POST', data: { id: it.id, mode_type: 0, type: 1 } }).catch(() => null),
  ]);
  const info = g?.data?.info;
  if (!info || info.sales_num_sp == null) return null; // barang tanpa data SP (mis. sudah off sale)
  return {
    id: it.id,
    name: it.name,
    price: it.price,
    gapSp: Number(info.sales_num_sp || 0),
    gapA: Number(info.sales_num_a || 0),
    avgSp: Number(ts?.data?.average_info?.sale_num_total || 0),
    avgA: Number(ta?.data?.average_info?.sale_num_total || 0),
    spDue: Number(info.sales_num_sp || 0) > Number(ts?.data?.average_info?.sale_num_total || 0),
    aDue: Number(info.sales_num_a || 0) > Number(ta?.data?.average_info?.sale_num_total || 0),
  };
}

async function scanSpDue() {
  const items = await spItemList();
  const statuses = (await Promise.all(items.map(fetchSpStatus))).filter(Boolean);
  statuses.sort((a, b) => (b.spDue - a.spDue) || (b.gapSp / Math.max(b.avgSp, 1) - a.gapSp / Math.max(a.avgSp, 1)));
  const rupiah = (v) => Number(v || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
  const fmt = (s) => {
    const pct = s.avgSp > 0 ? Math.round((s.gapSp / s.avgSp) * 100) : 0;
    const mark = s.spDue ? ' 🔥' : '';
    return `• ${s.name.slice(0, 42)}${mark}\n    roll tanpa SP ${s.gapSp} / avg ${s.avgSp} (${pct}%) — Rp ${rupiah(s.price)}/roll`;
  };
  const due = statuses.filter((s) => s.spDue);
  const msg = `🔍 Scanner SP — ${new Date().toLocaleString('id-ID')}\n${statuses.length} barang, ${due.length} jatuh tempo 🔥\n${statuses.map(fmt).join('\n')}`;
  log(msg);
  await ntfy('🎯 Boxkia: SP due checker', msg);
  return statuses;
}

/* ---------------- loop ---------------- */

let lastOverview = 0;
const reportRetry = new Map(); // eventId -> kapan boleh coba laporan lagi (ms)

async function loopOnce(forceOverview = false) {
  const t0 = Date.now();
  let fast = false;
  let scheduleList = null;
  const bursts = [];

  // fetch jadwal SEMUA akun secara paralel — biar semua akun nembak di momen yang sama
  const results = await Promise.all(ACCOUNTS.map(async (acct) => {
    try {
      return { acct, data: await loadSchedule(acct) };
    } catch (e) {
      log(`⚠ [${acct.name}] error fetch list: ${e?.message || e}`);
      return null;
    }
  }));

  for (const res of results) {
    if (!res) continue;
    const { acct, data } = res;
    const list = data.list || [];
    spends.set(acct.key, data.activity_info?.user_spend_amount ?? 0);
    if (!scheduleList) scheduleList = list;

    for (const a of list) {
      if (!targetMatch(a)) continue;
      const att = attempted.get(acct.key);
      const jo = joined.get(acct.key);
      if (a.is_join == 1 || jo.has(a.id)) { att.add(a.id); attemptedAny.add(a.id); continue; }
      if (a.is_progress === 2) continue;
      const why = ineligibleReason(a, spends.get(acct.key), users.get(acct.key));
      if (why) {
        if (!att.has(a.id)) {
          att.add(a.id);
          log(`  ⏭ [${acct.name}] skip #${a.id} (${a.start_time}, ${TYPE_NAME[a.type]}) — ${why}`);
        }
        continue;
      }
      const startsIn = (a.diff_time_start ?? 0) - (Date.now() - t0);
      if (a.is_progress === 1 || startsIn <= CFG.earlyFireMs) {
        bursts.push(joinBurst(a, acct, spends.get(acct.key)));
      } else if (startsIn < CFG.fastWindowMs) {
        fast = true;
      }
    }
  }

  // lapor hasil undian untuk event target yang sudah selesai & pernah dicoba
  // (kalau record masih kosong, coba lagi 60 detik kemudian)
  if (scheduleList) {
    for (const a of scheduleList) {
      if (attemptedAny.has(a.id) && a.is_progress === 2 && !reported.has(a.id)) {
        if (Date.now() >= (reportRetry.get(a.id) ?? 0)) {
          const ok = await reportResult(a);
          if (!ok) reportRetry.set(a.id, Date.now() + 60000);
        }
      }
    }
  }

  if (scheduleList && (forceOverview || Date.now() - lastOverview > 60000)) {
    printSchedule(scheduleList);
    lastOverview = Date.now();
  }

  await Promise.all(bursts);
  return fast;
}

/* ---------------- mode GitHub Actions (single-shot) ---------------- */
// Di GitHub Actions bot nggak bisa loop terus (job max 6 jam, cron min 5 menit).
// Mode ini: job cron tiap 5 menit -> kalau ada event target mulai <= 6 menit lagi,
// tidur sampai fast window -> fast-poll + burst join -> lapor hasil -> keluar.
// State (jadwal harian + event yang sudah dilapor) persist lewat DATA_DIR (cache Actions).
const ACTIONS_HORIZON = 6 * 60 * 1000; // ms: hanya tangani event yang mulai <= 6 menit lagi (diff_time_start dalam ms)

async function actionsMode() {
  // jadwal harian: kirim sekali sehari (state tersimpan di DATA_DIR/cache)
  const now = new Date();
  const dailyState = loadDailyState();
  if (now.toLocaleDateString('id-ID') !== dailyState.lastDate && now.getHours() >= (CFG.dailyScheduleHour ?? 0)) {
    dailyState.lastDate = now.toLocaleDateString('id-ID');
    saveDailyState(dailyState);
    await reportDailySchedule();
  }

  // fetch jadwal semua akun + refresh spend
  const results = await Promise.all(ACCOUNTS.map(async (acct) => {
    try { return { acct, data: await loadSchedule(acct) }; }
    catch (e) { log(`⚠ [${acct.name}] error fetch list: ${e?.message || e}`); return null; }
  }));
  for (const r of results) {
    if (r) spends.set(r.acct.key, r.data.activity_info?.user_spend_amount ?? 0);
  }
  const first = results.find((r) => r && r.data);
  if (!first) { log('⚠ tidak ada data jadwal — keluar'); return; }

  const events = (first.data.list || [])
    .filter((a) => targetMatch(a) && a.is_progress !== 2)
    .sort((a, b) => a.diff_time_start - b.diff_time_start);

  // lapor hasil undian untuk event yang sudah selesai & belum pernah dilaporkan
  const reportedState = loadReported();
  for (const a of first.data.list || []) {
    if (a.is_progress === 2 && !reportedState.has(a.id)) {
      const ok = await reportResult(a);
      if (ok) reportedState.add(a.id);
    }
  }
  saveReported(reportedState);

  // cari event berikutnya yang masih bisa diikuti (ada akun eligible)
  const next = events.find((a) => {
    if (a.is_join == 1) return false;
    return ACCOUNTS.some((acct) => !ineligibleReason(a, spends.get(acct.key) ?? 0, users.get(acct.key)));
  });
  if (!next) { log('⏳ tidak ada event yang bisa diikuti hari ini — keluar'); return; }

  const startsIn = next.diff_time_start ?? 0; // ms
  if (startsIn > ACTIONS_HORIZON) {
    log(`⏳ event berikutnya #${next.id} (${next.start_time}) mulai dalam ${Math.round(startsIn / 1000)}s — di luar horizon ${ACTIONS_HORIZON / 1000}s, keluar`);
    return;
  }

  log(`🎯 event #${next.id} (${next.start_time}) mulai dalam ${Math.round(startsIn / 1000)}s — tunggu fast window`);
  const wakeAt = Date.now() + Math.max(0, startsIn - CFG.fastWindowMs);
  const waitMs = wakeAt - Date.now();
  if (waitMs > 1000) {
    log(`💤 tidur ${Math.round(waitMs / 1000)}s sampai fast window...`);
    await sleep(waitMs);
  }

  // fast loop: loopOnce berulang — burst join terjadi di dalamnya saat event mulai
  const deadline = Date.now() + CFG.fastWindowMs + CFG.retryMaxMs + 15000;
  while (Date.now() < deadline) {
    const f = await loopOnce();
    await sleep(f ? CFG.fastPollIntervalMs : 250);
    if (Date.now() > wakeAt + CFG.fastWindowMs + CFG.retryMaxMs) break;
  }

  log('✅ sesi Actions selesai');
}

/* ---------------- main ---------------- */

async function main() {
  if (!ACCOUNTS.length) {
    log('⚠ Tidak ada akun: isi "token" (atau daftar "accounts") di config.json.');
    return;
  }

  for (const acct of ACCOUNTS) {
    const u = await fetchUserInfo(acct).catch(() => null);
    users.set(acct.key, u);
    attempted.set(acct.key, new Set());
    joined.set(acct.key, new Set());
    if (u) {
      acct.name = u.nickname || `#${u.user_id}`;
      log(`Login OK — [${acct.name}] user_id=${u.user_id} level=${u.user_level} (visitorId: ${acct.visitorId})`);
    } else {
      log(`⚠ [${acct.name}] token tidak valid/kedaluwarsa — join akan ditolak (code 10003).`);
    }
  }

  if (args.has('--saldo')) { await reportBalances(); return; }
  if (args.has('--sp')) { await scanSpDue(); return; }
  if (args.has('--jadwal')) { await reportDailySchedule(); return; }
  if (args.has('--actions')) { await actionsMode(); return; }
  if (args.has('--check') || args.has('--once')) { await loopOnce(true); return; }

  const targetLabel = CFG.targetType === 'all' ? 'semua type (angpao + free box)' : TYPE_LABEL[CFG.targetType] || CFG.targetType;
  log(`🤖 Bot jalan (${ACCOUNTS.length} akun). Ctrl+C untuk berhenti. Target: ${targetLabel}`);
  await ntfy('🤖 Boxkia: bot AKTIF', `Bot menyala — ${ACCOUNTS.length} akun (${ACCOUNTS.map((a) => a.name).join(', ')}). Target: ${targetLabel}.`);
  await reportBalances();

  let lastBeat = Date.now();
  let lastSpCheck = Date.now();
  const spNotified = new Set(); // id barang yang sudah di-notify "jatuh tempo" (biar nggak spam)
  const dailyState = loadDailyState();
  while (true) {
    try {
      const fast = await loopOnce();
      const now = new Date();
      if (now.toLocaleDateString('id-ID') !== dailyState.lastDate && now.getHours() >= (CFG.dailyScheduleHour ?? 0)) {
        dailyState.lastDate = now.toLocaleDateString('id-ID');
        saveDailyState(dailyState);
        await reportDailySchedule();
      }
      if (CFG.heartbeatHours > 0 && Date.now() - lastBeat > CFG.heartbeatHours * 3600e3) {
        lastBeat = Date.now();
        await reportBalances('💓 Boxkia: bot hidup');
      }
      if (CFG.spCheckHours > 0 && Date.now() - lastSpCheck > CFG.spCheckHours * 3600e3) {
        lastSpCheck = Date.now();
        const statuses = await scanSpDue();
        const nowDue = new Set(statuses.filter((s) => s.spDue).map((s) => s.id));
        for (const s of statuses) {
          if (s.spDue && !spNotified.has(s.id)) {
            spNotified.add(s.id);
            await ntfy('🔥 Boxkia: SP jatuh tempo', `${s.name} — roll tanpa SP ${s.gapSp} sudah melewati rata-rata ${s.avgSp}. Chance SP naik! Harga Rp ${s.price}/roll.`);
          } else if (!s.spDue && spNotified.has(s.id)) {
            spNotified.delete(s.id); // SP sudah keluar / reset — boleh notify lagi nanti
          }
        }
      }
      await sleep(fast ? CFG.fastPollIntervalMs : CFG.pollIntervalMs);
    } catch (e) {
      log('⚠ error loop:', e?.message || e);
      await sleep(CFG.pollIntervalMs);
    }
  }
}

async function bye(reason) {
  log(`👋 Bot dihentikan — ${reason}`);
  await ntfy('⛔ Boxkia: bot MATI', `Bot dihentikan — ${reason}. ${ACCOUNTS.length} akun, ${new Date().toLocaleString('id-ID')}`);
  process.exit(0);
}
process.on('SIGINT', () => bye('Ctrl+C'));
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('unhandledRejection', (e) => log('⚠ unhandledRejection:', e?.message || e));
main().catch(async (e) => {
  log('FATAL:', e);
  await ntfy('⛔ Boxkia: bot MATI', `Error fatal: ${e?.message || e}`);
  process.exit(1);
});
