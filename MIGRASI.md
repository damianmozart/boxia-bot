# Migrasi ke Laptop Cadangan

Bot ini **100% portable** — cuma butuh folder + Node.js. Tidak ada data
tersimpan di laptop utama selain folder `C:\home\user\boxkia-bot` (token akun
ada di `config.json`, jadi ikut ter-copy).

## Langkah 1 — Copy folder (di laptop utama)

1. Copy folder **`C:\home\user\boxkia-bot`** ke flashdisk / Google Drive / dll.
2. Jangan lupa: **stop bot di laptop utama sebelum nyalain di laptop cadangan**
   (lihat "Penting" di bawah).

## Langkah 2 — Set up di laptop cadangan

1. Install **Node.js LTS** dari https://nodejs.org (versi 18+, yang penting `node -v` jalan).
2. Taruh folder hasil copy di laptop cadangan — disarankan di path yang sama:
   `C:\home\user\boxkia-bot` (biar file `.cmd` nggak perlu diedit).
3. Buka CMD di folder itu, tes dulu:
   ```bash
   node bot.mjs --check
   ```
   Harusnya muncul `Login OK` untuk 9 akun. Kalau ada `code 10003` (login
   required) berarti token-nya terikat device/IP — kabari, kita cari solusinya.
4. Tes watcher SP:
   ```bash
   node sp-watch.mjs --once
   ```
5. Start keduanya — double-click `run-boxkia.cmd` dan `run-sp-watch.cmd`
   (atau daftarkan auto-start, lihat Langkah 3).

## Langkah 3 — Auto-start saat login (opsional, butuh admin)

Buka PowerShell **sebagai Administrator**, lalu:
```powershell
Register-ScheduledTask -TaskName 'BoxkiaSpWatch' -Action (New-ScheduledTaskAction -Execute 'C:\home\user\boxkia-bot\run-sp-watch.cmd') -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force
Register-ScheduledTask -TaskName 'BoxkiaBot' -Action (New-ScheduledTaskAction -Execute 'C:\home\user\boxkia-bot\run-boxkia.cmd') -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force
```
Cek: `Get-ScheduledTask -TaskName 'BoxkiaBot','BoxkiaSpWatch'`
Hapus: `Unregister-ScheduledTask -TaskName 'BoxkiaBot','BoxkiaSpWatch' -Confirm:$false`

## Langkah 4 (alternatif) — jalan di VPS gratis ☁️

Bot ini cuma butuh koneksi **keluar** (ke api.boxkia.com + ntfy.sh), RAM kecil
(±100 MB), dan nggak butuh port terbuka — jadi cocok untuk VPS gratis.

**Opsi VPS gratis yang selalu nyala:**
- **Oracle Cloud Always Free** — paling dermawan: VM AMD 1-2 OCPU / 1 GB RAM
  (atau ARM Ampere sampai 4 OCPU / 24 GB) gratis selamanya. Perlu daftar pakai
  kartu kredit tapi nggak pernah ditagih.
- **Google Cloud e2-micro** — 1 VM kecil gratis selamanya (region
  us-west1/us-central1), perlu kartu kredit.
- ⚠️ Hindari: Vercel/Netlify/Cloudflare Workers (serverless — ada batas waktu
  eksekusi, nggak bisa loop terus), Render/Railway free (tidur kalau idle),
  AWS/Azure free (cuma 12 bulan).

**Setup (Ubuntu 18.04–24.04):**
```bash
# 1. Upload boxkia-bot-migrasi.zip ke server (scp atau console web Oracle/GCP)
# 2. Extract + jalankan script one-shot (dia install Node, tes token, pasang systemd):
sudo apt-get install -y unzip
unzip boxkia-bot-migrasi.zip && cd boxkia-bot
bash setup-vps.sh
```
Selesai — bot + SP watcher jalan otomatis, auto-restart kalau crash, auto-start
saat boot. Cek status: `systemctl status boxkia boxkia-sp-watch`.

Catatan:
- File `.service` sudah set `TZ=Asia/Jakarta` biar jam kirim jadwal harian
  (`dailyScheduleHour`) sesuai waktu Indonesia.
- `setup-vps.sh` otomatis menyesuaikan path ke lokasi folder — nggak harus di
  `/home/user/boxkia-bot`.
- IP server datacenter bisa beda dari IP rumah — kalau tiba-tiba join sering
  gagal, itu kemungkinan penyebabnya.

## Langkah 5 (alternatif) — GitHub Actions 🐙

Tanpa kartu kredit, tanpa VM — bot jalan sebagai workflow cron (repo public =
menit gratis tak terbatas). Panduan lengkap ada di **`ACTIONS.md`**: buat repo,
isi secret `BOXKIA_CONFIG` dengan isi penuh config.json, upload file, tes.
Catatan: latensi runner (US/EU) lebih tinggi dari rumah → peluang menang race
sedikit lebih kecil.

## Penting

- **JANGAN jalankan bot di dua tempat sekaligus** (laptop utama + cadangan, atau
  laptop + server) — join jadi dobel dan membanjiri server dengan request
  duplikat. Satu tempat saja yang menjalankan.
- Path di `run-boxkia.cmd` & `run-sp-watch.cmd` hardcoded ke
  `C:\home\user\boxkia-bot`. Kalau folder ditaruh di path lain, edit dua file
  itu (dan path di perintah Task Scheduler di atas).
- File state ikut ter-copy (`daily-schedule-state.json`, `sp-watch-state.json`).
  Kalau mau notif SP mulai dari nol, hapus `sp-watch-state.json`.
- Log lama ikut ter-copy. Kalau mau log bersih, hapus `boxkia-bot.log` &
  `sp-watch.log`.
