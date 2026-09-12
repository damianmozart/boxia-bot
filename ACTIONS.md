# Deploy ke GitHub Actions (gratis, tanpa kartu kredit) 🐙

Bot jalan sebagai **workflow** di GitHub — bukan VM. Tiap 5 menit job dicek
jadwal; begitu ada event yang mau mulai, job **arm** (berhenti polling jadwal),
menghitung jam tembak absolut, tidur presisi sampai waktunya, nembak join, lalu
melapor. Satu run bertahan sampai `ACTIONS_BUDGET_MS` (default 10 menit) — jadi
event yang jatuh di antara dua tick tetap ketangkep dan tidak pernah telat.

⚠️ **Cron GitHub TIDAK dipakai** — schedule-nya tidak reliable (delay lama /
tidak jalan di repo baru). Pemicu utama = `repository_dispatch` yang dikirim
oleh **cron-job.org** (gratis, tanpa kartu) setiap 5 menit.

## Kenapa repo public?

- **Public repo = menit Actions tak terbatas** (gratis).
- **Private repo = 2.000 menit/bulan** — sekarang tiap run bisa nyala sampai 10
  menit (nunggu event), jadi kuota private cepat habis. Pakai repo **Public**.
- Token akun tetap aman walau repo public karena disimpan di **Secrets**
  (nggak pernah ikut ter-commit / terlihat).

## Setup (sekali, ±10 menit)

1. **Buat akun GitHub** (github.com) — gratis, **tanpa kartu kredit**.
2. **Buat repo baru** (Public), nama misal `boxkia-bot`. Jangan centang
   "Add a README" dulu (biar gampang upload file).
3. **Upload file** ke repo (pakai tombol "Add file → Upload files"):
   - Seluruh isi folder `boxkia-bot` **KECUALI `config.json` asli**.
   - Buat `config.json` placeholder (token kosong) supaya repo punya file-nya:
     ```json
     { "accounts": [], "token": "", "ntfyTopic": "" }
     ```
   - Pastikan folder `.github/workflows/` ikut ter-upload (berisi
     `boxkia-event.yml` + `boxkia-sp.yml`).
4. **Tambah Secret:** repo → *Settings → Secrets and variables → Actions →
   New repository secret*:
   - Name: `BOXKIA_CONFIG`
   - Value: **isi penuh `config.json` asli kamu** (copy-paste seluruh isi file,
     termasuk 9 token akun + ntfyTopic).
5. **Tes:** tab *Actions* → pilih workflow `boxkia-event` → **Run workflow**
   (tombol kiri atas) → buka run-nya → lihat log: harusnya ada
   `Login OK` 9 akun + `⏳ event berikutnya ... keluar` (kalau nggak ada event
   dalam 10 menit). Notifikasi ntfy juga bisa dicek.

## Pemicu otomatis — cron-job.org (langkah terakhir, biar laptop bisa dimatikan)

1. **Buat Personal Access Token** (jangan pakai token utama):
   github.com → Settings → Developer settings → Personal access tokens →
   Generate new token (classic) → scope: **repo** → Generate → salin.
2. **Daftar cron-job.org** (gratis, tanpa kartu kredit) → buat **cron job baru**:
   - Request method: **POST**
   - URL: `https://api.github.com/repos/damianmozart/boxia-bot/dispatches`
   - Schedule: **every 5 minutes**
   - Header `Authorization`: `Bearer <PAT dari langkah 1>`
   - Header `Content-Type`: `application/json`
   - Body: `{"event_type":"tick"}`
   - Simpan, lalu cek tab **Run history** — harusnya `HTTP 204`.
3. Setelah cron-job.org jalan (cek: ada run baru tiap 5 menit di tab Actions),
   **matikan dispatcher lokal** (`dispatch-ping.mjs`) — laptop bebas dimatikan.

## Setelah itu otomatis

- **Bot event:** pemicu tiap 5 menit → join event 10:00–21:00 otomatis, notif
  ✅/❌ ke HP seperti biasa.
- **Jadwal harian 📅:** terkirim sekali sehari (state disimpan di cache).
- **Monitor SP:** scan tiap 5 menit (ikut pemicu yang sama), notif ⚠️/🔥/✅ +
  dedup via cache.
- **Hasil undian 📊:** dilaporkan setelah event selesai (dedup via cache).
- **Pity board 📊:** sekali sehari (job cron-job.org **8269426**, jam 08:00 WIB)
  kirim papan pity SP — roll sejak SP terakhir + rata-rata/median/min/max dari
  histori, % progress vs rata-rata, dan sisa roll. Bisa juga dipanggil manual:
  `node sp-watch.mjs --pity --notify` (atau via Actions tab → `boxkia-pity` →
  Run workflow).

## Catatan penting

- **Latensi:** runner GitHub (US/EU) → API Jakarta ±200–400 ms lebih lambat dari
  rumah. Lead time tembakan sekarang menyesuaikan RTT otomatis (RTT × 0.6), jadi
  request pertama mendarat tepat saat event dibuka — tapi kalau kuota 100 slot
  habis dalam <200 ms, runner US memang masih kalah dari orang yang koneksinya ke
  Jakarta. Untuk race yang benar-benar ketat, jalankan bot di VPS region
  **Singapore** (`fly.toml`, lihat `FLYIO.md`) — RTT-nya ±50–80 ms.
- **Cron jitter:** job bisa telat mulai ±1–2 menit — sekarang diantisipasi dengan
  budget 10 menit per run (lebih besar dari jeda tick 5 menit), jadi telat
  beberapa menit pun tetap ke-join.
- **JANGAN commit `config.json` asli** ke repo public — token bisa dicuri.
- Kalau mau ubah frekuensi scan SP: edit `cron` di `.github/workflows/boxkia-sp.yml`.
- Mau hapus semuanya? Settings repo → *Danger Zone → Delete this repository*.
