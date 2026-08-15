# Deploy ke Fly.io (free tier) 🪰

Kenapa Fly: VM **selalu nyala 24/7**, bisa pilih region **Singapore** (latensi
rendah ke API Jakarta), free allowance **3 VM kecil + 160 GB egress/bulan**.

## Sebelum mulai

- `config.json` sudah diset `pollIntervalMs: 5000` — ini yang bikin egress
  turun dari ±246 GB ke ±100 GB/bulan (muat di kuota 160 GB). Presisi event
  nggak terpengaruh karena fast window (60 dtk sebelum mulai) yang jaga timing.
- `bot.mjs` & `sp-watch.mjs` sekarang dukung `DATA_DIR` → log & state disimpan
  di volume persistent, jadi nggak hilang tiap redeploy.
- ⚠️ IP Fly = IP datacenter (bukan IP rumah) — risiko kecil akun game di-flag.
- ⚠️ Egress bertambah seiring jumlah akun. 9 akun ≈ 100 GB/bln; ±18 akun bisa
  tembus 160 GB.

## Deploy (sekali, ±10 menit)

```powershell
# 1. Install flyctl + login (daftar butuh kartu kredit, nggak ditagih di allowance):
iwr https://fly.io/install/fly.ps1 -useb | iex
fly auth login

# 2. Buat app bot event:
cd C:\home\user\boxkia-bot
fly apps create boxkia-bot
fly volumes create boxkia_data --size 1 --region sin
fly deploy

# 3. Buat app watcher SP:
fly apps create boxkia-sp-watch
fly volumes create boxkia_watch_data --size 1 --region sin
fly deploy -c fly.toml.watch

# 4. Cek:
fly logs
fly status
```

## Operasional

```powershell
fly logs            # log kedua app
fly status          # status VM
fly scale count 1 --region sin   # pastikan cuma 1 VM (gratis)
fly destroy boxkia-bot boxkia-sp-watch   # hapus kalau mau berhenti total
```

## Catatan

- Volume minimal 1 GB; free tier kasih 3 GB total — 2× volume 1 GB muat.
- Kalau mau nambah akun, ingat egress-nya ikut naik (lihat catatan di atas).
- JANGAN jalankan bot di dua tempat sekaligus (laptop + Fly).
