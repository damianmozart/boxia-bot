#!/usr/bin/env node
/*
 * boxkia-bot — bot otomatis untuk event Treasure Hunt Boxkia
 * (https://boxkia.com/treasureHunt) — angpao (type 1) & free box (type 0).
 * Mendukung MULTI-AKUN: tiap akun pakai token sendiri, join paralel.
 *
 * Cara kerja:
 *   1. Polling GET  /activity/luckyBag/list  per akun (jadwal + is_join + spend per akun)
 *   2. Pantau countdown (diff_time_start) tiap event target
 *   3. Begitu event masuk armWindowMs, berhenti polling jadwal → hitung waktu
 *      tembak absolut (mulai − lead, lead nyesuaikan RTT) → tidur presisi →
 *      tembak POST /activity/luckyBag/join {id} paralel (lihat joinConcurrency)
 *      sampai ada vonis: sukses / sudah ikut / gagal permanen / timeout.
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
 *   node bot.mjs --notif-test — kirim 1 notifikasi tes ke ntfy, lalu keluar
 *   node bot.mjs --hasil [id]  — kirim laporan hasil undian (posisi + dapat berapa) ke ntfy
 *   node bot.mjs --actions    — mode GitHub Actions (single-shot): selama budget
 *                                (actionsBudgetMs) bot menunggu presisi lalu join,
 *                                habis itu keluar — tick berikutnya lanjut lagi
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
  minEarlyFireMs: 120,         // lead time minimal (earlyFireMs lama = 3000ms DIABAIKAN, lihat effectiveLead)
  maxEarlyFireMs: 900,         // batas atas lead adaptif (RTT dari GitHub Actions bisa 200-400ms)
  retryIntervalMs: 120,        // jeda antar putaran tembakan di dalam burst
  retryMaxMs: 8000,            // durasi maksimal burst
  joinConcurrency: 3,          // maksimum request join yang "in flight" per akun
  joinTimeoutMs: 3000,         // timeout tiap request join (harus < retryMaxMs)
  armWindowMs: 20000,          // X ms sebelum mulai: berhenti polling jadwal, tidur presisi
  // free-box (type 0): target kapan join-nya MENDARAT di server, dihitung dari
  // waktu mulai. Posisi ~20-30an tercapai di sekitar 1 detik setelah mulai
  // (data peserta: 21 orang di detik ke-0, +15 di detik ke-1).
  freeBoxDelayMs: 1000,        // free-box: join mendarat X ms SETELAH mulai
  freeBoxDelayJitterMs: 300,   // tambahan acak 0..X ms, biar posisinya bervariasi
  postFireCooldownMs: 1500,    // jeda santai setelah nembak, biar nggak rebutan request list
  actionsBudgetMs: 600000,     // mode Actions: berapa lama satu run boleh bertahan (ms)
  waitResultMs: 180000,        // seberapa lama menunggu hasil undian muncul setelah nembak (ms)
  apiTimeoutMs: 15000,         // timeout tiap request API — cegah fetch macet membekukan bot
  ntfyTopic: '',
  ...JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8')),
};

// Override tuning lewat env — dipakai buat tes (mis. BOXKIA_ARM_WINDOW_MS=99999999).
for (const [key, env] of Object.entries({
  armWindowMs: 'BOXKIA_ARM_WINDOW_MS',
  retryMaxMs: 'BOXKIA_RETRY_MAX_MS',
  maxEarlyFireMs: 'BOXKIA_MAX_EARLY_FIRE_MS',
  freeBoxDelayMs: 'BOXKIA_FREEBOX_DELAY_MS',
  freeBoxDelayJitterMs: 'BOXKIA_FREEBOX_JITTER_MS',
  pollIntervalMs: 'BOXKIA_POLL_MS',
  joinConcurrency: 'BOXKIA_JOIN_CONCURRENCY',
})) {
  if (process.env[env]) CFG[key] = Number(process.env[env]);
}
// Override non-angka — dipakai buat tes lokal lawan mock API, dan buat ganti topik ntfy.
if ('BOXKIA_API_BASE' in process.env) CFG.apiBase = process.env.BOXKIA_API_BASE;
if ('BOXKIA_NTFY_TOPIC' in process.env) CFG.ntfyTopic = process.env.BOXKIA_NTFY_TOPIC;

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

/* Buang akun kembar (user_id sama). Config pernah memuat akun yang sama dua kali:
 * efeknya satu akun "makan" satu slot tembakan, dan laporan hasil menampilkan
 * akun kembar dengan posisi identik seolah-olah dua akun berbeda. Dipanggil
 * sesudah login (user_id baru diketahui dari API). */
function dropDuplicateAccounts() {
  const seen = new Map();
  for (let i = ACCOUNTS.length - 1; i >= 0; i--) {
    const a = ACCOUNTS[i];
    const uid = users.get(a.key)?.user_id;
    if (uid == null) continue;
    if (seen.has(String(uid))) {
      const first = seen.get(String(uid));
      ACCOUNTS.splice(i, 1);
      log(`⚠ akun duplikat: [${a.name}] (user_id ${uid}) sama dengan [${first}] — dikeluarkan dari daftar.`);
    } else {
      seen.set(String(uid), a.name);
    }
  }
}
const users = new Map();     // key -> userInfo
const spends = new Map();    // key -> user_spend_amount hari ini
const attempted = new Map(); // key -> Set(eventId)
const joined = new Map();    // key -> Set(eventId)
const attemptedAny = new Set(); // event id yang pernah ditembak/diikuti (lintas akun)
const reported = new Set();     // kunci event (id@tanggal) yang hasil undiannya sudah dilaporkan
// Event yang ditembak di RUN SEBELUMNYA, dalam bentuk kunci `id@tanggal`. Bot mode
// Actions itu proses baru tiap tick, jadi tanpa ini hasil undian yang belum final
// saat run berakhir (mis. pemenang free-box baru ditentukan 30 menit kemudian)
// tidak akan pernah dilaporkan.
const attemptedPrev = new Set();

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
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) log(`⚠ ntfy gagal: HTTP ${res.status} (${title})`);
  } catch (e) {
    log(`⚠ ntfy gagal: ${e?.message || e} (${title})`);
  }
}

async function api(p, { account, method = 'GET', params, data, timeoutMs } = {}) {
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
    signal: AbortSignal.timeout(timeoutMs ?? CFG.apiTimeoutMs),
  });
  return res.json();
}

// RTT ke API (EWMA) — dipakai buat ngatur lead time tembakan. Latensi dari
// GitHub Actions (US) ke API Jakarta gampang 200-400ms, jauh lebih besar dari
// latensi laptop lokal (±30ms). Kalau lead-nya nggak nyesuaikan RTT, request
// pertama selalu datang telat dan kita kalah balapan.
let LAST_RTT_MS = 0;

// Akun mana pun yang tokennya valid — buat request yang cuma butuh login dan
// bukan milik akun tertentu (mis. daftar peserta/record). Dulu tempat ini
// memakai token level-atas (CFG.token) yang nggak ada lagi sejak config pindah
// ke multi-akun, jadi hasilnya selalu "login required" dan laporan hasil undian
// selalu kosong.
function anyAccount() {
  return ACCOUNTS.find((a) => users.get(a.key)) || ACCOUNTS[0] || CFG;
}

function targetMatch(a) {
  if (CFG.targetType === 'all') return true;
  return a.type === Number(CFG.targetType);
}

/* Kenapa akun ini tidak punya record di event tersebut? Bisa karena memang tidak
 * memenuhi syarat (level/belanja) sehingga bot tidak pernah menembak — beda dengan
 * kalah cepat. Dipakai di laporan supaya tidak menyebut "kalah cepat" padahal
 * akunnya sejak awal tidak eligible. Mengembalikan null kalau kita tidak yakin
 * (mis. data belanja belum diambil) — lebih baik generik daripada salah. */
function skipReason(a, acct) {
  const u = users.get(acct.key);
  if (!u) return null;
  if (a.type === 0 && u.user_level < (a.level_limit || 0)) {
    return `syarat LV${a.level_limit} — akun LV${u.user_level}`;
  }
  if (a.type === 1 && spends.has(acct.key) && Number(spends.get(acct.key) || 0) < (a.limit_price || 0)) {
    return `syarat belanja ${a.limit_price} — akun ${spends.get(acct.key)}`;
  }
  return null;
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
  const t0 = Date.now();
  const r = await api('/activity/luckyBag/list', { account: acct });
  const rtt = Date.now() - t0;
  LAST_RTT_MS = LAST_RTT_MS ? Math.round(LAST_RTT_MS * 0.6 + rtt * 0.4) : rtt;
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

/*
 * Pelajaran dari log produksi — inilah yang bikin "telat / too slow":
 *   • "1 Too slow, all gone"       → request datang setelah kuota habis.
 *   • "1 Duplicate participation"  → akun SUDAH ikut. Kalau tetap ditembak 8 detik,
 *                                    dia cuma nyolong bandwidth akun lain yang belum masuk.
 *   • "20000 ... not eligible"     → syarat nggak dipenuhi; nembak ulang sia-sia.
 * Jadi cuma error SEMENTARA (network/timeout/not-started) yang boleh di-retry.
 * Sisanya berhenti saat itu juga, biar burst-nya efisien dan akun lain kebagian.
 */
function classifyJoin(r) {
  const code = r?.code;
  const msg = String(r?.msg || '');
  if (code === 0) return { kind: 'ok' };
  if (code === 10003 || /login\s*required/i.test(msg)) return { kind: 'terminal', reason: 'token mati/kosong' };
  if (/duplicate/i.test(msg)) return { kind: 'already' };
  if (/too slow|all gone|sold out|habis|ended|finished/i.test(msg)) return { kind: 'terminal', reason: 'kalah cepat — kuota habis' };
  if (code === 20000 || /not eligible/i.test(msg)) return { kind: 'terminal', reason: msg.trim() || 'tidak memenuhi syarat' };
  return { kind: 'retry', reason: `${code ?? '?'} ${msg}`.trim() };
}

async function tryJoin(acct, a) {
  try {
    const r = await api('/activity/luckyBag/join', {
      account: acct, method: 'POST', data: { id: a.id },
      timeoutMs: Math.min(Number(CFG.joinTimeoutMs) || 3000, CFG.retryMaxMs),
    });
    return classifyJoin(r);
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? `timeout ${CFG.joinTimeoutMs}ms` : String(e?.message || e);
    return { kind: 'retry', reason };
  }
}

/* Satu akun: PIPELINE, bukan batch.
 * Data peserta nunjukin kuota angpao (100 slot) habis di detik pertama — 89 orang
 * masuk dalam 1 detik. Jadi yang menentukan bukan "berapa banyak request", tapi
 * "apakah ada request yang MENDARAT tepat setelah T0".
 * Cara lama (kirim 2 sekaligus, tunggu balasan, kirim lagi) bikin request
 * menggerombol lalu nganggur sepanjang RTT — di cloud RTT-nya 200-400ms, jadi
 * cuma ada ~2 kesempatan per detik. Sekarang request diluncurkan satu per satu
 * tiap `retryIntervalMs` tanpa menunggu, jadi kedatangan di server tersebar rapi
 * melewati detik pembukaan.
 */
const RANK = { ok: 3, already: 2, terminal: 1 };

async function joinOne(acct, a, deadline) {
  const maxInflight = Math.max(1, Number(CFG.joinConcurrency) || 1);
  const interval = Math.max(40, Number(CFG.retryIntervalMs) || 120);
  const inflight = new Set();
  let best = null;
  let last = 'belum sempat';

  const launch = () => {
    const p = tryJoin(acct, a)
      .then((res) => {
        if (res.kind === 'retry') { last = res.reason; return; }
        if (!best || RANK[res.kind] > RANK[best.kind]) best = res;
      })
      .catch(() => { /* kegagalan tak terduga: anggap retry */ })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  while (Date.now() < deadline && !best) {
    if (inflight.size < maxInflight) launch();
    await sleep(interval);
  }
  if (!best && inflight.size) await Promise.allSettled([...inflight]);
  return best || { kind: 'timeout', reason: last };
}

async function fireBurst(a, accts) {
  const pending = accts.filter((acct) => !attempted.get(acct.key)?.has(a.id));
  if (!pending.length) return;
  for (const acct of pending) attempted.get(acct.key).add(a.id);
  attemptedAny.add(a.id);
  attemptedPrev.add(reportKey(a));
  try { saveAttemptedKeys(attemptedPrev); } catch { /* abaikan */ }

  const name = TYPE_NAME[a.type] || `type${a.type}`;
  if (DRY) {
    log(`  [dry-run] ${pending.length} akun akan join ${name} #${a.id} (${a.start_time}) — tidak dikirim`);
    return;
  }

  log(`⚡ ${name} #${a.id} (${a.start_time}) — ${pending.length} akun nembak (conc ${CFG.joinConcurrency}, burst ${CFG.retryMaxMs}ms)`);
  const deadline = Date.now() + CFG.retryMaxMs;
  const started = Date.now();
  const outcomes = await Promise.all(pending.map(async (acct, idx) => {
    // stagger ringan: hindari 9 koneksi baru di millisecond yang sama persis,
    // tapi tetap rapat (maks 120ms) biar akun terakhir nggak kalah start
    if (idx) await sleep(Math.min(idx * 15, 120));
    const res = await joinOne(acct, a, deadline);
    if (res.kind === 'ok') joined.get(acct.key).add(a.id);
    return { acct, res };
  }));

  const lines = outcomes.map(({ acct, res }) => {
    if (res.kind === 'ok') return `✅ ${acct.name} — IKUT (masuk undian)`;
    if (res.kind === 'already') return `🟡 ${acct.name} — sudah ikut sebelumnya`;
    if (res.kind === 'timeout') return `⏹ ${acct.name} — mentok ${CFG.retryMaxMs}ms (${res.reason})`;
    return `⛔ ${acct.name} — ${res.reason}`;
  });
  const okN = outcomes.filter((o) => o.res.kind === 'ok').length;
  const dupN = outcomes.filter((o) => o.res.kind === 'already').length;
  const head = `${name} #${a.id} (${a.start_time}) — ✅${okN} ikut · 🟡${dupN} sudah · ⛔${outcomes.length - okN - dupN} gagal · ${Date.now() - started}ms`;
  log(`📣 ${head}\n${lines.join('\n')}`);
  await ntfy(okN ? '✅ Boxkia: ikut berhasil' : '⚠️ Boxkia: ada yang gagal', `${head}\n${lines.join('\n')}`);
}

/* ---------------- laporan hasil undian ---------------- */

const rupiah = (v) => Number(v || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Detik ke berapa join-nya tercatat, dihitung dari jam mulai event. Berguna buat
// cek apakah timing tembakan kita sudah benar (angpao: 89/100 slot habis di detik 0).
function secAfterStart(a, joinDate) {
  const parse = (s) => {
    const m = String(s || '').match(/(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
    if (!m) return null;
    let h = Number(m[1]);
    const mer = (m[4] || '').toUpperCase();
    if (mer) { h %= 12; if (mer === 'PM') h += 12; }
    return h * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
  };
  const s = parse(joinDate);
  const t0 = parse(a.start_time);
  return s == null || t0 == null ? null : s - t0;
}

/* Kapan event ini mulai (instan absolut). `start_time` cuma jam ("09:00 PM") dan
 * id event dipakai ulang tiap hari, jadi waktu mulai harus dihitung dari
 * `diff_time_start` (ms relatif ke sekarang; negatif kalau sudah lewat). */
function eventStartAt(a) {
  const d = Number(a?.diff_time_start);
  return Number.isFinite(d) ? Date.now() + d : null;
}

/* Record API memisahkan hari lewat `date_type`: 0 = hari ini, 1 = kemarin.
 * Salah pilih = laporan menampilkan hasil undian HARI LAIN sebagai hasil event
 * ini (kejadian nyata: hasil angpao #244 dilaporkan pakai posisi kemarin).
 * null = lebih tua dari kemarin, nggak ada date_type-nya. */
function dateTypeOf(a) {
  const at = eventStartAt(a);
  if (at == null) return 0;
  const days = Math.round((dayStart(Date.now()) - dayStart(at)) / 86400000);
  if (days <= 0) return 0;          // mulai hari ini (atau belum mulai)
  return days === 1 ? 1 : null;     // kemarin
}

function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* Kunci laporan per event PER HARI. Id event dipakai ulang tiap hari, jadi kalau
 * dikunci pakai id saja, event slot yang sama besok dianggap "sudah dilaporkan"
 * dan laporannya hilang. */
function reportKey(a) {
  const at = eventStartAt(a);
  return `${a.id}@${new Date(at == null ? dayStart(Date.now()) : dayStart(at)).toLocaleDateString('id-ID')}`;
}

/* Daftar peserta + hasil undian untuk SATU hari tertentu. Tidak ada fallback ke
 * hari lain: kalau record hari itu belum ada, kembalikan kosong supaya pemanggil
 * mencoba lagi — bukan melaporkan data kemarin sebagai hasil hari ini. */
async function fetchRecords(id, dateType) {
  const acct = anyAccount();
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const r = await api('/activity/luckyBag/record', { account: acct, params: { page, page_size: 50, id, date_type: dateType } }).catch(() => null);
    if (!r || r.code !== 0 || !r.data) break;
    const list = r.data.list || [];
    for (const rec of list) if (!seen.has(rec.id)) { seen.add(rec.id); all.push(rec); }
    if (list.length < 50) break;
  }
  return all;
}

/* Laporan hasil undian: posisi TIAP akun + berapa yang didapat.
 *
 * `sale_num` = posisi masuk (1 = paling awal). `amount` = uang yang DIDAPAT akun
 * itu, dan artinya beda per tipe event:
 *   - angpao (type 1): kolam (`price`) dibagi ke SEMUA peserta → tiap peserta
 *     dapat bagian acak, dan jumlah semua `amount` = `price`. `is_win` cuma
 *     menandai bagian terbesar. Jadi "dapat Rp 0" untuk peserta angpao itu SALAH.
 *   - free-box (type 0): hadiah jatuh ke satu pemenang → yang lain `amount` 0.
 * Karena itu "didapat" dihitung dari `amount`, bukan dari `is_win`. */
async function reportResult(a) {
  const dt = dateTypeOf(a);
  if (dt == null) return true;                       // lebih tua dari kemarin — di luar jangkauan record
  const all = await fetchRecords(a.id, dt);
  if (!all.length) return false;                     // hari itu belum ada record → coba lagi, jangan pakai hari lain
  reported.add(reportKey(a));
  try { saveReported(reported); } catch { /* abaikan */ }

  const total = all.length;
  const quota = Number(a.join_user_limit) || 0;
  const endsIn = Number(a.diff_time_end);
  const ended = Number.isFinite(endsIn) && endsIn <= 0;
  let gotTotal = 0, gotCount = 0, joined = 0, bestPos = Infinity;
  const rows = ACCOUNTS.map((acct) => {
    const u = users.get(acct.key);
    if (!u) return `• ${acct.name} — token mati`;
    const rec = all.find((x) => String(x.user_id) === String(u.user_id));
    if (!rec) {
      const why = skipReason(a, acct);
      return why
        ? `• ${acct.name} — ⏭ tidak ikut (${why})`
        : `• ${acct.name} — ❌ tidak masuk (kalah cepat)`;
    }
    joined++;
    const pos = Number(rec.sale_num) || 0;
    if (pos) bestPos = Math.min(bestPos, pos);
    const dsec = secAfterStart(a, rec.join_date);
    const at = dsec == null || dsec < 0 || dsec > 600 ? '' : ` · T+${dsec}s`;
    const amt = Number(rec.amount || 0);
    if (amt > 0) { gotCount++; gotTotal += amt; }
    const prize = (a.user_list || []).find((w) => String(w.user_id) === String(u.user_id))?.goods_name;
    const badge = rec.is_win == 1
      ? (a.type === 0 ? ` 🏆 MENANG${prize ? ' ' + prize : ''}` : ' 🏆 share terbesar')
      : '';
    return `• ${acct.name}${badge} — posisi ${pos}/${total}${at} · dapat Rp ${rupiah(amt)}`;
  });

  // Hasil undian kadang belum final walau daftar record-nya sudah ada (pemenang
  // free-box baru ditentukan menjelang/akhir event). Jangan lapor "belum ada yang
  // dapat" padahal hadiahnya belum diundi: biarkan pemanggil mencoba lagi — dan
  // JANGAN tandai sudah dilaporkan, supaya bisa dilaporkan di tick berikutnya.
  if (gotTotal === 0 && joined > 0 && !ended) return false;

  const label = TYPE_NAME[a.type] || `type${a.type}`;
  const title = gotTotal > 0
    ? `💰 ${label}: ${gotCount} akun dapat Rp ${rupiah(gotTotal)}`
    : `📊 ${label}: belum ada yang dapat`;
  const head = `${label} #${a.id} · ${a.start_time} (${dt === 0 ? 'hari ini' : 'kemarin'}) · peserta ${total}${quota ? `/${quota}` : ''} · ${joined}/${ACCOUNTS.length} akun masuk`;
  const tail = [
    gotTotal > 0 ? `💰 Total didapat: Rp ${rupiah(gotTotal)}` : '',
    Number.isFinite(bestPos) ? `Posisi terbaik kita: #${bestPos}/${total}` : '',
  ].filter(Boolean).join('\n');
  const msg = `${head}\n${rows.join('\n')}${tail ? '\n' + tail : ''}`;
  log(`${title}\n${msg}`);
  await ntfy(title, msg);
  return true;
}

/* Dipanggil tepat sesudah burst: tunggu sampai hasil undian keluar, lalu lapor.
 * Undian angpao selesai begitu kuota penuh (±2 detik), tapi daftar record kadang
 * baru terisi beberapa detik setelahnya — jadi dicoba berkala selama waitResultMs. */
async function collectResults(budgetEnd = Infinity) {
  const waitUntil = Math.min(budgetEnd, Date.now() + (Number(CFG.waitResultMs) || 180000));
  for (;;) {
    let list = null;
    try { list = (await loadSchedule(ACCOUNTS[0])).list || []; } catch { /* coba lagi */ }
    let pending = !list;
    if (list) {
      for (const a of list) {
        if (!wasAttempted(a) || reported.has(reportKey(a))) continue;
        if (!(await reportResult(a))) pending = true;
      }
    }
    if (!pending) return;
    if (Date.now() + 15000 > waitUntil) return;   // batas tunggu habis
    if (msUntilNextFire() < 15000) return;        // ada event lain yang mau ditembak
    await sleep(15000);
  }
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

const ATTEMPTED_FILE = path.join(DATA_DIR, 'attempted-events.json');
function loadAttemptedKeys() {
  try { return new Set(JSON.parse(readFileSync(ATTEMPTED_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveAttemptedKeys(s) {
  // buang yang lebih tua dari kemarin — kuncinya `id@dd/mm/yyyy`
  const cutoff = dayStart(Date.now()) - 86400000;
  for (const k of [...s]) {
    const [d, m, y] = String(k).split('@')[1]?.split('/').map(Number) || [];
    if (!d || !m || !y || new Date(y, m - 1, d).getTime() < cutoff) s.delete(k);
  }
  try { mkdirSync(path.dirname(ATTEMPTED_FILE), { recursive: true }); writeFileSync(ATTEMPTED_FILE, JSON.stringify([...s])); } catch { /* abaikan */ }
}

// true = event ini pernah kita tembak (sekarang atau di run sebelumnya)
function wasAttempted(a) {
  return attemptedAny.has(a.id) || attemptedPrev.has(reportKey(a));
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
const skipLogged = new Map();  // "key:id" -> alasan skip terakhir (biar log nggak spam tiap poll)

/* ---------------- penjadwal presisi: ARM → FIRE ----------------
 * Dulu bot memakai "fast poll": tempur jadwal tiap 250ms di 30 detik terakhir.
 * Dua masalahnya: (1) granularitas poll 250ms bikin tembakan pertama meleset,
 * (2) 9 akun × 4 request jadwal/detik = ±36 req/detik di detik paling kritis —
 *     justru di saat itu semua bandwidth/rate-limit dipakai buat request yang
 *     nggak perlu.
 * Sekarang: begitu event masuk armWindowMs, bot BERHENTI polling jadwal,
 * menghitung jam tembak absolut (mulai − lead, lead nyesuaikan RTT), tidur
 * presisi, lalu nembak. Nol request jadwal di detik-detik kritis.
 */
const armed = new Map(); // eventId -> { a, accts, fireAt }

/* Lead time = perkiraan waktu tempuh request ke server (RTT × 0.6), dibatasi
 * [minEarlyFireMs, maxEarlyFireMs]. Ini yang bikin request pertama MENDARAT tepat
 * di detik event dibuka, bukan sesudahnya.
 * Catatan: earlyFireMs lama di config (3000ms) sengaja diabaikan — nembak 3 detik
 * sebelum event dibuka cuma menghasilkan putaran "not started" yang mubazir di
 * detik paling kritis, dan di log malah pernah balik "duplicate participation". */
function effectiveLead() {
  const min = Math.max(0, Number(CFG.minEarlyFireMs ?? 120));
  const max = Math.max(min, Number(CFG.maxEarlyFireMs) || 900);
  return Math.round(Math.min(max, Math.max(min, (LAST_RTT_MS || 0) * 0.6)));
}

/* Free box (type 0) sengaja TIDAK direbutkan posisi pertama — diminta masuk di
 * posisi 20-an/30-an, jadi join-nya dijadwalkan MENDARAT `freeBoxDelayMs` ms
 * setelah event dibuka (plus jitter acak). Angpao (type 1) tetap tembak presisi
 * saat dibuka karena kuotanya habis dalam <1 detik. */
function freeBoxDelay() {
  const base = Math.max(0, Number(CFG.freeBoxDelayMs) || 0);
  const jitter = Math.max(0, Number(CFG.freeBoxDelayJitterMs) || 0);
  return base + (jitter ? Math.random() * jitter : 0);
}

function nextFireAt() {
  let m = Infinity;
  for (const e of armed.values()) if (e.fireAt < m) m = e.fireAt;
  return m;
}

async function sleepUntil(t) {
  for (;;) {
    const d = t - Date.now();
    if (d <= 0) return;
    await sleep(d > 80 ? d - 25 : d);
  }
}

function msUntilNextFire() {
  const nf = nextFireAt();
  return Number.isFinite(nf) ? Math.max(0, nf - Date.now()) : Infinity;
}

async function fireArmed() {
  if (!armed.size) return 0;
  const due = [...armed.entries()].filter(([, e]) => Date.now() >= e.fireAt - 2);
  for (const [id] of due) armed.delete(id);
  await Promise.all(due.map(([, e]) => fireBurst(e.a, e.accts)));
  return due.length;
}

async function loopOnce(forceOverview = false) {
  const fetchTime = Date.now();
  let scheduleList = null;

  // fetch jadwal SEMUA akun secara paralel — biar semua akun nembak di momen yang sama
  const results = await Promise.all(ACCOUNTS.map(async (acct) => {
    try {
      return { acct, data: await loadSchedule(acct) };
    } catch (e) {
      log(`⚠ [${acct.name}] error fetch list: ${e?.message || e}`);
      return null;
    }
  }));

  // kumpulkan event target lintas akun: id -> { a, accts[] }
  const targets = new Map();
  for (const res of results) {
    if (!res) continue;
    const { acct, data } = res;
    const list = data.list || [];
    spends.set(acct.key, data.activity_info?.user_spend_amount ?? 0);
    if (!scheduleList) scheduleList = list;

    for (const a of list) {
      if (!targetMatch(a) || a.is_progress === 2) continue;
      if (a.is_join == 1 || joined.get(acct.key)?.has(a.id)) { attempted.get(acct.key).add(a.id); attemptedAny.add(a.id); continue; }
      if (attempted.get(acct.key).has(a.id) || armed.get(a.id)?.accts.includes(acct)) continue;
      const why = ineligibleReason(a, spends.get(acct.key), users.get(acct.key));
      if (why) {
        // JANGAN tandai attempted — kalau nanti akun jadi eligible (mis. habis belanja),
        // event ini masih bisa ditembak. Log-nya cukup sekali per alasan.
        const sk = `${acct.key}:${a.id}`;
        if (skipLogged.get(sk) !== why) {
          skipLogged.set(sk, why);
          log(`  ⏭ [${acct.name}] skip #${a.id} (${a.start_time}, ${TYPE_NAME[a.type]}) — ${why}`);
        }
        continue;
      }
      if (!targets.has(a.id)) targets.set(a.id, { a, accts: [] });
      targets.get(a.id).accts.push(acct);
    }
  }

  // arm yang sebentar lagi mulai; tembak yang sudah waktunya
  const now = Date.now();
  const lead = effectiveLead();
  const fireNow = [];
  let soonestStartsIn = Infinity;
  for (const { a, accts } of targets.values()) {
    const startsIn = (a.diff_time_start ?? 0) - (now - fetchTime);
    if (startsIn < soonestStartsIn) soonestStartsIn = startsIn;
    if (a.is_progress === 1) { fireNow.push(fireBurst(a, accts)); continue; }

    // free box: offset = "mendarat X ms setelah mulai" dikurangi RTT, supaya
    // waktu MENDARAT-nya yang presisi (posisi ditentukan saat server menerima,
    // bukan saat kita mengirim). angpao: tembak sebelum mulai (lead).
    const offset = a.type === 0 ? freeBoxDelay() - (LAST_RTT_MS || 0) : -lead;
    const target = startsIn + offset;
    if (target <= 0) {
      fireNow.push(fireBurst(a, accts));
    } else if (startsIn <= CFG.armWindowMs) {
      armed.set(a.id, { a, accts, fireAt: now + target });
      const mode = offset >= 0 ? `delay ${Math.round(offset)}ms` : `lead ${-Math.round(offset)}ms`;
      log(`🛡 arm ${TYPE_NAME[a.type]} #${a.id} — tembak dalam ${Math.round(target)}ms (${accts.length} akun, ${mode})`);
    }
  }

  // lapor hasil undian untuk event yang sudah selesai & pernah dicoba.
  // Ditunda HANYA kalau ada event yang lagi di-arm / sebentar lagi ditembak —
  // request laporan nggak boleh nyolong waktu kritis. (Dulu syaratnya
  // `!targets.size`, jadi laporan ke-skip terus selama masih ada event lain
  // yang eligible di hari itu.)
  const criticalWindow = armed.size > 0 || soonestStartsIn <= CFG.armWindowMs;
  if (scheduleList && !criticalWindow) {
    for (const a of scheduleList) {
      if (wasAttempted(a) && a.is_progress === 2 && !reported.has(reportKey(a)) && Date.now() >= (reportRetry.get(a.id) ?? 0)) {
        const ok = await reportResult(a);
        if (!ok) reportRetry.set(a.id, Date.now() + 60000);
      }
    }
  }

  if (scheduleList && (forceOverview || Date.now() - lastOverview > 60000)) {
    printSchedule(scheduleList);
    lastOverview = Date.now();
  }

  await Promise.all(fireNow);
  return { armedCount: armed.size, nextFire: nextFireAt(), soonestStartsIn, hasTarget: targets.size > 0 };
}

/* ---------------- mode GitHub Actions (single-shot) ---------------- */
// Di GitHub Actions bot nggak bisa loop terus (job max 6 jam, cron min 5 menit).
// Mode ini: job cron tiap 5 menit -> kalau ada event target mulai <= 6 menit lagi,
// tidur sampai fast window -> fast-poll + burst join -> lapor hasil -> keluar.
// State (jadwal harian + event yang sudah dilapor) persist lewat DATA_DIR (cache Actions).
// Budget satu run — HARUS lebih besar dari jeda tick cron (5 menit). Dengan budget
// 10 menit, tiap event PASTI ketangkep: selalu ada tick yang datang <= 5 menit
// sebelum event, dan run itu tidur presisi sampai waktu tembak. Ini yang menghapus
// "telat" akibat runner GitHub nyala lambat atau dispatch repository_dispatch telat.

async function actionsMode() {
  // jadwal harian: kirim sekali sehari (state tersimpan di DATA_DIR/cache)
  const now = new Date();
  const dailyState = loadDailyState();

  // lapor status akun ke ntfy — sekali sehari (bukan tiap run biar nggak spam)
  if (dailyState.lastDate !== now.toLocaleDateString('id-ID')) {
    const acctStatus = ACCOUNTS.map((a) => {
      const u = users.get(a.key);
      return u ? `✅ ${a.name} (LV${u.user_level})` : `❌ ${a.name} (token invalid)`;
    });
    const ok = ACCOUNTS.filter((a) => users.get(a.key)).length;
    await ntfy(`🔑 Akun: ${ok}/${ACCOUNTS.length} konek`, acctStatus.join('\n'));
  }
  if (now.toLocaleDateString('id-ID') !== dailyState.lastDate && now.getHours() >= (CFG.dailyScheduleHour ?? 0)) {
    dailyState.lastDate = now.toLocaleDateString('id-ID');
    saveDailyState(dailyState);
    await reportDailySchedule();
  }

  const budgetMs = Math.max(60000, Number(process.env.ACTIONS_BUDGET_MS || CFG.actionsBudgetMs) || 600000);
  const budgetEnd = Date.now() + budgetMs;
  log(`🕒 sesi Actions — budget ${Math.round(budgetMs / 1000)}s`);

  for (;;) {
    // ada event yang sudah di-arm → tidur presisi sampai waktu tembak (tanpa polling jadwal)
    const nf = nextFireAt();
    if (Number.isFinite(nf)) {
      if (nf >= budgetEnd) { log('⏳ tembakan berikutnya di luar budget sesi ini — keluar'); break; }
      log(`💤 tidur presisi ${((nf - Date.now()) / 1000).toFixed(1)}s sampai waktu tembak...`);
      await sleepUntil(nf - 2);
      if (await fireArmed()) {
        // cooldown, tapi jangan sampai menunda event berikutnya yang sudah di-arm
        // (mis. angpao lalu free-box yang delay-nya cuma 2-3 detik)
        const cd = Number(CFG.postFireCooldownMs) || 1500;
        const wait = Math.min(cd, msUntilNextFire());
        if (wait > 0) await sleep(wait);
        // tunggu undiannya kelar lalu kirim laporan posisi + dapat berapa.
        // Batas waktunya budget sesi, jadi nggak akan nyangkut sebelum keluar.
        await collectResults(budgetEnd);
      }
      continue;
    }

    const left = budgetEnd - Date.now();
    if (left <= 0) { log('⏳ budget sesi habis — keluar'); break; }

    const st = await loopOnce();
    if (st.armedCount) { await sleep(200); continue; }
    if (!Number.isFinite(st.soonestStartsIn)) { log('✅ tidak ada event target tersisa hari ini — keluar'); break; }
    // Target jauh di luar budget: keluar SEKARANG. Kalau tidak, run-nya cuma
    // muter-muter polling sampai budget habis (dulu ini bikin run nyangkut 10 menit).
    if (st.soonestStartsIn > left) {
      log(`⏳ event berikutnya ${Math.round(st.soonestStartsIn / 1000)}s lagi (budget tersisa ${Math.round(left / 1000)}s) — keluar, tick berikutnya yang lanjut`);
      break;
    }
    // Tidur sampai event mau masuk arm window (di-cap 60s biar jadwal baru cepat
    // ketahuan) — jauh lebih hemat daripada polling tiap 2 detik selama menit-menitan.
    await sleep(Math.max(200, Math.min(st.soonestStartsIn - CFG.armWindowMs, left, 60000)));
  }

  log('✅ sesi Actions selesai');
}

/* ---------------- main ---------------- */

async function main() {
  // Tes jalur notifikasi — sengaja di paling atas supaya tetap bisa dipakai
  // walau config.json belum ada token yang valid.
  if (args.has('--notif-test')) {
    if (!CFG.ntfyTopic) { log('⚠ ntfyTopic kosong di config.json — notifikasi mati.'); return; }
    const stamp = new Date().toLocaleString('id-ID');
    await ntfy('🔔 Boxkia: tes notifikasi', `Tes jalur notifikasi — ${stamp}\nTopic: ${CFG.ntfyTopic}\nKalau pesan ini masuk ke HP, jalur notif sehat.`);
    log(`🔔 Notif tes dikirim ke topic "${CFG.ntfyTopic}" — cek HP.`);
    return;
  }

  if (!ACCOUNTS.length) {
    log('⚠ Tidak ada akun: isi "token" (atau daftar "accounts") di config.json.');
    return;
  }

  // muat riwayat dari disk: laporan yang sudah dikirim (biar restart nggak
  // mengirim ulang) dan event yang sudah ditembak (biar laporan yang tertunda ke
  // run berikutnya tetap bisa dikirim).
  for (const k of loadReported()) reported.add(k);
  for (const k of loadAttemptedKeys()) attemptedPrev.add(k);

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
  dropDuplicateAccounts();

  if (args.has('--saldo')) { await reportBalances(); return; }
  if (args.has('--sp')) { await scanSpDue(); return; }
  if (args.has('--jadwal')) { await reportDailySchedule(); return; }
  if (args.has('--actions')) { await actionsMode(); return; }
  if (args.has('--hasil')) {
    const wantId = Number([...args].find((x) => /^\d+$/.test(x))) || null;
    let list = [];
    try { list = (await loadSchedule(ACCOUNTS[0])).list || []; } catch { /* abaikan */ }
    const candidates = wantId
      ? [list.find((x) => x.id === wantId) || { id: wantId, type: 1, start_time: '--' }]
      : list.filter((x) => x.is_progress === 2).sort((a, b) => b.diff_time_start - a.diff_time_start).slice(0, 4);
    if (!candidates.length) { log('⚠ Tidak ada event yang selesai hari ini. Pakai: node bot.mjs --hasil <id>'); return; }
    // coba dari event terbaru; kalau record-nya belum ada, mundur ke event sebelumnya
    for (const ev of candidates) {
      if (await reportResult(ev)) return;
      log(`⚠ #${ev.id} hasilnya belum final (record belum ada / undian belum jalan) — coba event sebelumnya.`);
    }
    return;
  }

  if (args.has('--check') || args.has('--once')) {
    await loopOnce(true);
    if (armed.size) { await sleepUntil(nextFireAt() - 2); await fireArmed(); }
    return;
  }

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
      // ada event yang sudah di-arm → tidur presisi lalu tembak (tanpa polling jadwal)
      const nf = nextFireAt();
      if (Number.isFinite(nf)) {
        await sleepUntil(nf - 2);
        if (await fireArmed()) {
          const wait = Math.min(Number(CFG.postFireCooldownMs) || 1500, msUntilNextFire());
          if (wait > 0) await sleep(wait);
        }
        continue;
      }

      await loopOnce();
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
        for (const s of statuses) {
          if (s.spDue && !spNotified.has(s.id)) {
            spNotified.add(s.id);
            await ntfy('🔥 Boxkia: SP jatuh tempo', `${s.name} — roll tanpa SP ${s.gapSp} sudah melewati rata-rata ${s.avgSp}. Chance SP naik! Harga Rp ${s.price}/roll.`);
          } else if (!s.spDue && spNotified.has(s.id)) {
            spNotified.delete(s.id); // SP sudah keluar / reset — boleh notify lagi nanti
          }
        }
      }
      await sleep(armed.size ? 20 : CFG.pollIntervalMs);
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
