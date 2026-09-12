# Deploy bot event ke Fly.io (region Singapore) 🪰

## Kenapa pindah dari GitHub Actions

Kuota angpao itu balapan sub-detik. Data peserta asli (lihat
`node analyze-participants.mjs 244 --at 21:00`) menunjukkan:

```
angpao #244 — 100 slot
detik 0 → 89 orang masuk (posisi 1-89)
detik 1 → 11 orang masuk (posisi 90-100)  → kuota HABIS
```

Yang menentukan menang atau `1 Too slow, all gone` adalah berapa lama request
kita sampai ke server Jakarta:

| Tempat jalan | RTT ke API Jakarta |
|---|---|
| Runner GitHub Actions (US) | **±200-400 ms** |
| Fly.io region `sin` (Singapore) | **±50-80 ms** |
| Laptop/HP di Indonesia | ±10-30 ms |

Selisih 250-300 ms itu jauh lebih besar dari seluruh jendela balapan. Di Fly,
bot juga jalan **terus-menerus** — tidak ada lagi delay dispatch cron, cold start
runner, atau job yang ngantre.

## Biaya — baca dulu sebelum mulai

**Fly.io sudah tidak punya free tier untuk akun baru.** Yang ada: trial singkat
(beberapa jam VM), lalu pay-as-you-go dan **kartu kredit wajib terdaftar**.
Perkiraan untuk bot ini: **±$2/bulan** (1 mesin `shared-cpu-1x` 256 MB + volume
1 GB). Akun lama yang masih punya legacy free allowance mungkin masih gratis —
cek dulu di dashboard.

Kalau mau gratis dan tetap cepat: jalankan bot di device sendiri di Indonesia
(RTT-nya justru paling rendah, ±10-30 ms). Satu-satunya syarat: devicenya nyala.
Pakai `run-boxkia.cmd` / `run-boxkia.sh`.

## Prasyarat (sekali saja)

```powershell
# 1. Install flyctl (Windows PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
#    (tutup & buka ulang PowerShell setelah ini)

# 2. Daftar / login — butuh kartu kredit
fly auth login
```

## Deploy (satu perintah, aman diulang)

```powershell
cd C:\home\user\boxkia-bot
powershell -ExecutionPolicy Bypass -File deploy-fly.ps1
```

Atau manual:

```powershell
fly apps create boxkia-bot
fly volumes create boxkia_data --region sin --size 1 --yes
fly deploy --ha=false
```

Yang dipakai: `fly.toml` (bot event) dan `Dockerfile`. `config.json` ikut ke
dalam image — registry Fly privat ke organisasimu, dan `config.json` memang
sudah di-gitignore. `.dockerignore` menjaga log 15 MB & riwayat `.git` tidak
ikut ter-upload.

## WAJIB setelah deploy: matikan bot event di Actions

Kalau tidak, ada DUA bot yang nembak join di event yang sama.

```
GitHub → Settings → Secrets and variables → Actions → tab Variables
→ New repository variable → Name: BOXKIA_FLY_ACTIVE   Value: true
```

Atau lewat gh CLI:

```bash
gh variable set BOXKIA_FLY_ACTIVE --body true
```

Job `boxkia-event` sudah punya guard `if: ${{ vars.BOXKIA_FLY_ACTIVE != 'true' }}`,
jadi begitu variabelnya di-set, job-nya dilewati total (tanpa memakan menit).

**Monitor SP tetap di GitHub Actions** — itu nggak butuh latensi rendah, dan
gratis. Tidak perlu deploy `fly.toml.watch`.

## Operasional

```powershell
fly logs -a boxkia-bot          # log langsung
fly status -a boxkia-bot        # status mesin
fly ssh console -a boxkia-bot   # masuk ke container
fly scale count 1 -a boxkia-bot # pastikan cuma 1 mesin
```

Re-deploy setelah ubah `bot.mjs` / `config.json` (mis. token baru):

```powershell
powershell -ExecutionPolicy Bypass -File deploy-fly.ps1
# atau: fly deploy --ha=false
```

Mau berhenti total:

```powershell
fly apps destroy boxkia-bot
# lalu hapus variabel BOXKIA_FLY_ACTIVE di GitHub kalau mau balik ke Actions
```

## Catatan

- Volume `boxkia_data` dipasang di `/data` — log & state (`daily-schedule-state.json`,
  `reported-events.json`) persist antar deploy.
- `TZ=Asia/Jakarta` di-set di `fly.toml` dan `Dockerfile`; tanpa itu log dan
  laporan jadwal harian ngikut UTC (geser 7 jam).
- IP Fly itu IP datacenter, bukan IP rumah — risiko kecil akun di-flag.
- **JANGAN jalankan bot di dua tempat sekaligus** (laptop + Fly + Actions).
  Kalau balapan tetap dobel, lihat bagian "WAJIB" di atas.
- Egress ikut naik kalau nambah akun. `pollIntervalMs` default sekarang 5000 ms
  di `config.json`; menaikkannya menurunkan pemakaian bandwidth.
