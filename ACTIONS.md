# Deploy ke GitHub Actions (gratis, tanpa kartu kredit) 🐙

Bot jalan sebagai **workflow** di GitHub — bukan VM. Tiap 5 menit job mengecek
jadwal; kalau ada event mulai ≤ 6 menit lagi, job tidur sampai fast window,
burst join, lapor hasil, lalu keluar.

⚠️ **Cron GitHub TIDAK dipakai** — schedule-nya tidak reliable (delay lama /
tidak jalan di repo baru). Pemicu utama = `repository_dispatch` yang dikirim
oleh **cron-job.org** (gratis, tanpa kartu) setiap 5 menit.

## Kenapa repo public?

- **Public repo = menit Actions tak terbatas** (gratis).
- **Private repo = 2.000 menit/bulan** — bot kita butuh ±2.000 menit/bulan
  (11 event/hari × ±6 menit) → mepet banget.
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
   dalam 6 menit). Notifikasi ntfy juga bisa dicek.

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

- **Latensi:** runner GitHub (US/EU) → API Jakarta ±100–250 ms lebih lambat
  dari rumah → peluang menang race 70-slot sedikit lebih kecil. Itu alasan
  kenapa bot rumah (laptop/HP) tetap lebih unggul; Actions ini oke sebagai
  **pengganti** kalau nggak ada device nyala, atau sebagai **backup**.
- **Cron jitter:** job bisa telat mulai ±1–2 menit — sudah diantisipasi dengan
  horizon 6 menit + tidur sampai fast window.
- **JANGAN commit `config.json` asli** ke repo public — token bisa dicuri.
- Kalau mau ubah frekuensi scan SP: edit `cron` di `.github/workflows/boxkia-sp.yml`.
- Mau hapus semuanya? Settings repo → *Danger Zone → Delete this repository*.
