#!/usr/bin/env node
/*
 * freebox-draw.mjs — automasi Daily Free Blind Box draw.
 * Khusus 3 akun: West said, Boxkia 27895, Femzy.
 *
 * API:
 *   GET  /api/v3/home/extraIntegral/freeBlindBox/detail?blind_box_id=67122
 *   POST /api/v3/home/extraIntegral/freeBlindBox/submit {blind_box_id: 67122}
 *
 * Status: 0=locked, 1=ready to draw, 2=already drawn (wait reset)
 *
 * Mode:
 *   node freebox-draw.mjs           — draw sekali, lalu keluar
 *   node freebox-draw.mjs --check   — cek status saja
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const BASE = 'https://api.boxkia.com/api/v3';
const BLIND_BOX_ID = 67122; // LV2 Free Blind Box
const TARGET_NAMES = ['West said', 'Femzy', 'Boxkia 27895'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOG_FILE = path.join(DATA_DIR, 'freebox-draw.log');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');

function log(...parts) {
  const line = `[${new Date().toLocaleString('id-ID')}] ${parts.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
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
    if (!res.ok) log(`⚠ ntfy gagal: HTTP ${res.status}`);
  } catch (e) {
    log(`⚠ ntfy gagal: ${e?.message || e}`);
  }
}

async function api(url, acct, method = 'GET', body = null) {
  const h = {
    'Content-Type': 'application/json',
    token: acct.token,
    lang: 'id',
    'X-Device-VisitorId': acct.visitorId,
    'User-Agent': UA,
  };
  const opts = { method, headers: h, signal: AbortSignal.timeout(15000) };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

async function getStatus(acct) {
  const d = await api(`${BASE}/home/extraIntegral/freeBlindBox/detail?blind_box_id=${BLIND_BOX_ID}`, acct);
  return d.data?.free_blind_box_info || null;
}

async function draw(acct) {
  const d = await api(`${BASE}/home/extraIntegral/freeBlindBox/submit`, acct, 'POST', { blind_box_id: BLIND_BOX_ID });
  return d;
}

async function main() {
  const accounts = (CFG.accounts || []).filter(a => a.token && TARGET_NAMES.includes(a.name));
  
  if (!accounts.length) {
    log('⚠ Tidak ada target akun ditemukan di config.json');
    return;
  }

  log(`🎲 Free Blind Box — ${accounts.length} akun target`);

  const results = [];
  for (const acct of accounts) {
    const info = await getStatus(acct);
    if (!info) {
      log(`  ❌ ${acct.name}: gagal ambil status`);
      results.push({ name: acct.name, status: 'error' });
      continue;
    }

    const statusLabel = { 0: '🔒 Locked', 1: '✅ Siap draw', 2: '⏳ Sudah draw' };
    log(`  ${statusLabel[info.status] || '?'} ${acct.name} (LV${info.level})`);

    if (info.status === 0) {
      log(`    → Level kurang (butuh LV${info.level})`);
      results.push({ name: acct.name, status: 'locked' });
      continue;
    }

    if (info.status === 2) {
      const resetH = Math.round(info.next_time_unix / 3600000);
      log(`    → Sudah draw hari ini. Reset dalam ~${resetH} jam`);
      results.push({ name: acct.name, status: 'already_drawn' });
      continue;
    }

    if (info.status === 1 && CHECK_ONLY) {
      log(`    → Siap draw (cek saja, --check mode)`);
      results.push({ name: acct.name, status: 'ready' });
      continue;
    }

    // DRAW!
    if (info.status === 1) {
      log(`  🎯 ${acct.name}: DRAWING...`);
      const r = await draw(acct);
      if (r.code === 0) {
        const prize = r.data?.list_raw?.[0]?.name || r.data?.name || 'unknown';
        const prizeRank = r.data?.list_raw?.[0]?.winning_rank_name || '';
        log(`  ✅ ${acct.name}: MENANG! ${prizeRank} ${prize}`);
        results.push({ name: acct.name, status: 'won', prize: `${prizeRank} ${prize}` });
      } else {
        log(`  ❌ ${acct.name}: code=${r.code} msg=${r.msg}`);
        results.push({ name: acct.name, status: 'failed', msg: r.msg });
      }
    }
  }

  // Summary notification
  const won = results.filter(r => r.status === 'won');
  const drawn = results.filter(r => r.status === 'already_drawn');
  const ready = results.filter(r => r.status === 'ready');
  const summary = results.map(r => {
    if (r.status === 'won') return `✅ ${r.name}: ${r.prize}`;
    if (r.status === 'already_drawn') return `⏳ ${r.name}: sudah draw`;
    if (r.status === 'locked') return `🔒 ${r.name}: level kurang`;
    if (r.status === 'ready') return `🎯 ${r.name}: siap draw`;
    return `❌ ${r.name}: ${r.msg || 'error'}`;
  }).join('\n');

  const title = won.length > 0 
    ? `🎁 Free Box: ${won.length}/${results.length} MENANG!` 
    : `🎲 Free Box: ${results.length} akun selesai`;
  
  log(title);
  log(summary);
  await ntfy(title, summary);
}

main().catch(async (e) => {
  log('FATAL:', e?.message || e);
  await ntfy('❌ Free Box Error', e?.message || String(e));
  process.exit(1);
});
