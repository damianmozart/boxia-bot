# Deploy ke GitHub Actions (gratis, tanpa kartu kredit) 🐙

Bot jalan sebagai **workflow cron** — bukan VM. Tiap 5 menit job mengecek jadwal;
kalau ada event mulai ≤ 6 menit lagi, job tidur sampai fast window, burst join,
lapor hasil, lalu keluar.

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

## Setelah itu otomatis

- **Bot event:** cron `*/5` → join event 10:00–21:00 otomatis, notif ✅/❌ ke
  HP seperti biasa.
- **Jadwal harian 📅:** terkirim sekali sehari (state disimpan di cache).
- **Monitor SP:** scan tiap jam (menit 17), notif ⚠️/🔥/✅ + dedup via cache.
- **Hasil undian 📊:** dilaporkan setelah event selesai (dedup via cache).

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
