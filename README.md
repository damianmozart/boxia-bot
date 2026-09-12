# boxkia-bot 🤖

Bot untuk event **Treasure Hunt** di Boxkia (<https://boxkia.com/treasureHunt>).
Boxkia mengadakan event **angpao** (red envelope) dan **free box** di jam-jam
tertentu setiap hari, dan hadiahnya diambil siapa cepat dia dapat (kuota
terbatas). Bot ini memantau jadwal lewat API resminya dan menekan tombol
"ikuti/瓜分" **tepat saat event mulai** — jauh lebih cepat daripada klik manual.

Zero dependency — cukup Node.js 18+ (pakai `fetch` bawaan, tidak perlu `npm install`).

## Cara pakai

### 1. Ambil token login kamu (sekali saja)

1. Login ke <https://boxkia.com> lewat browser (Chrome/Edge).
2. Tekan `F12` → tab **Application** → **Local Storage** → `https://boxkia.com`.
3. Salin nilai `token` → tempel ke `config.json` di bagian `"token"`.
4. (Opsional) Salin juga `countryObject` → ambil nilai `id`-nya → isi `"countryId"`.
   Kalau kosong, bot tetap jalan untuk event yang tidak butuh negara tertentu.

Token itu rahasia (sama seperti password) — jangan share ke siapa pun.

> **Token ditolak (`Login required`)?** Biasanya karena sudah kedaluwarsa atau
> salah salin. Pastikan: (1) kamu **benar-benar sudah login** di browser itu
> (buka boxkia.com dan lihat profil kamu), (2) salin dari **Local Storage →
> `https://boxkia.com`** (bukan `api.showgo.gg`, bukan Session Storage),
> (3) nilai yang disalin persis sama dengan di kolom Value. Cek juga key
> `userInfo` di tempat yang sama — JSON-nya harus berisi `"user_id":402860`
> (kalau ya tapi token tetap ditolak, berarti token lama sudah mati →
> logout lalu login ulang untuk dapat token baru).
>
> **Tes cepat dari browser (Console di https://boxkia.com):**
> ```js
> fetch('https://api.showgo.gg/api/v2/user/info',{method:'POST',headers:{'Content-Type':'application/json',token:localStorage.token,lang:'id','country-id':(JSON.parse(localStorage.countryObject||'{}').id)||'','X-Device-VisitorId':localStorage.visitorId||''},body:'{}'}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))
> ```
> Hasil `"code":0` = token OK. Hasil `"code":10003` = sesi mati → logout
> lalu login ulang untuk dapat token baru (nilai `localStorage.token` akan
> berubah), lalu salin lagi ke `config.json`.

### 2. Jalankan

```bash
node bot.mjs --check    # cek token + lihat jadwal hari ini, lalu keluar
node bot.mjs --saldo    # tampilkan saldo & poin tiap akun, lalu keluar
node bot.mjs --sp       # scan barang SP: "roll tanpa SP" vs "avg rolls" (due checker), lalu keluar
node bot.mjs            # jalan terus — biarkan terminal ini terbuka
```

Atau double-click `run-boxkia.cmd`.

> 💡 Coba dulu dengan `node bot.mjs --dry-run` kalau mau lihat log simulasi
> tanpa benar-benar join.

### 3. Biarkan jalan

Bot harus **jalan pada saat event mulai** — jangan matikan komputernya, jangan
tidurkan laptopnya (atur agar tidak sleep saat di-charge). Setelah berhasil
ikut, bot mencatat log ke `boxkia-bot.log`.

Agar jalan otomatis saat Windows login, daftarkan ke Task Scheduler
(butuh hak administrator — jalankan dari terminal yang di-**Run as administrator**,
atau pakai perintah di bawah lalu setujui prompt UAC):

```powershell
# Bot event angpao (biar tidak perlu manual start):
Register-ScheduledTask -TaskName 'BoxkiaBot' -Action (New-ScheduledTaskAction -Execute 'C:\home\user\boxkia-bot\run-boxkia.cmd') -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force

# Monitor SP otomatis (sp-watch.mjs):
Register-ScheduledTask -TaskName 'BoxkiaSpWatch' -Action (New-ScheduledTaskAction -Execute 'C:\home\user\boxkia-bot\run-sp-watch.cmd') -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force
```

Cek: `Get-ScheduledTask -TaskName 'BoxkiaSpWatch'`
Hapus: `Unregister-ScheduledTask -TaskName 'BoxkiaSpWatch' -Confirm:$false`

## Config (`config.json`)

| Key | Arti |
|-----|------|
| `accounts` | **Daftar akun** — tiap akun punya `name`, `token`, `countryId`, `visitorId` (lihat contoh di bawah). Kalau kosong, bot pakai `token` di level atas |
| `token` | Token login dari localStorage boxkia.com (dipakai kalau `accounts` kosong) |
| `countryId` | `id` dari `countryObject` di localStorage (opsional) |
| `visitorId` | ID device bebas, untuk header `X-Device-VisitorId` |
| `lang` | Bahasa header API (`id`, `en`, `ms`, …) |
| `apiBase` | Base URL API (default `https://api.boxkia.com/api/v2` — jangan diganti kecuali tahu apa yang dilakukan) |
| `targetType` | `1` = angpao saja, `0` = free box saja, `all` = keduanya |
| `pollIntervalMs` | Jeda polling jadwal normal (default 2000 ms) |
| `armWindowMs` | X ms sebelum mulai bot berhenti polling jadwal, hitung waktu tembak, lalu tidur presisi (default 20000) |
| `minEarlyFireMs` / `maxEarlyFireMs` | Batas lead time tembakan (default 120 / 900 ms). Lead aslinya mengikuti RTT ke API × 0.6 — di cloud RTT-nya jauh lebih besar dari lokal, jadi lead-nya menyesuaikan sendiri. **`earlyFireMs` lama (3000 ms) sudah diabaikan** karena nembak 3 detik kelewat awal cuma buang putaran "not started" |
| `joinConcurrency` | Jumlah request `join` paralel per akun (default 2). Naikkan kalau mau lebih agresif saat rebutan kuota |
| `joinTimeoutMs` | Timeout tiap request join (default 3000 ms) — harus < `retryMaxMs` supaya satu request macet tidak menelan seluruh burst |
| `retryIntervalMs` | Jeda antar putaran tembakan di dalam burst (default 120 ms) |
| `retryMaxMs` | Lama maksimal burst (default 8000 ms) |
| `freeBoxDelayMs` | **Free box (type 0) saja**: join X ms *setelah* event dibuka (default 2000). Tujuannya supaya masuk di posisi ~20-an/30-an, bukan juara 1 — free box tidak diperebutkan. Set `0` kalau mau ikut ngebut juga |
| `freeBoxDelayJitterMs` | Tambahan acak 0..X ms untuk free box (default 1000), biar posisinya tidak selalu persis sama |
| `postFireCooldownMs` | Jeda santai setelah selesai nembak (default 1500 ms) — biar request jadwal berikutnya tidak ikut rebutan di detik kritis. Otomatis dipangkas kalau ada event lain yang sudah di-arm |
| `actionsBudgetMs` | Mode `--actions`: lama satu run bertahan (default 600000 = 10 menit). **Wajib > jeda tick cron** supaya tiap event pasti ketangkep |
| `apiTimeoutMs` | Timeout tiap request API (default 15000 ms) — mencegah fetch yang macet membekukan bot |
| `ntfyTopic` | Topic ntfy.sh (opsional) untuk notifikasi ke HP saat berhasil/gagal, plus laporan hasil undian (`📊 Hasil …`) setelah event selesai dan laporan saldo (`💰 Saldo …`) saat bot start & tiap heartbeat |
| `spCheckHours` | **Scanner SP otomatis** — kalau > 0 (mis. `1`), bot mengecek tiap X jam apakah ada barang yang SP-nya "jatuh tempo" (roll tanpa SP sudah melewati rata-rata) dan kirim notif `🔥` ke ntfy. Default `0` = mati |
| `dailyScheduleHour` | Jam (0–23) kirim **ringkasan jadwal hari ini** (`📅`) ke ntfy — daftar event + akun mana yang memenuhi syarat (elig). Default `0` = tengah malam. Bisa kirim manual kapan saja dengan `node bot.mjs --jadwal` |

Kalau sudah sering "kehabisan", naikkan `joinConcurrency` ke `3` dan kecilkan
`retryIntervalMs` ke `80`. Jangan terlalu agresif — kalau ketahuan membanjiri
server, akun bisa kena batasan.

> **Angpao vs free box.** Angpao (type 1) rebutan kuota 100 orang, jadi ditembak
> presisi saat event dibuka. Free box (type 0) nggak perlu jadi yang pertama —
> default-nya digeser `freeBoxDelayMs` (+ jitter) setelah mulai, jadi kamu masuk
> di urutan 20-an/30-an.

> **Kapan bot berhenti nembak?** Begitu dapat vonis dari server: `code 0` (ikut),
> `duplicate` (sudah ikut), `too slow / all gone` (kuota habis), `not eligible`,
> atau `login required`. Dulu semua error itu diulang selama 8 detik penuh —
> percuma, dan justru menyita bandwidth akun yang masih berpeluang. Sekarang
> hanya error sementara (timeout/network) yang di-retry.

## Multi-akun

Tambah akun kedua, ketiga, dst. dengan menduplikasi entri di `accounts`:

```json
"accounts": [
  { "name": "akun1", "token": "TOKEN_AKUN_1", "countryId": "8", "visitorId": "boxkia-bot-1", "lang": "id" },
  { "name": "akun2", "token": "TOKEN_AKUN_2", "countryId": "8", "visitorId": "boxkia-bot-2", "lang": "id" }
]
```

Tiap akun harus punya token sendiri (login terpisah di browser, salin
`localStorage.token` masing-masing). Bot mengecek syarat (level/spend) per akun,
menampilkan status `✓`/`✗` per akun di jadwal, dan menembak join untuk semua
akun secara paralel saat event mulai. Log ditandai nama akun (`[akun1]`).

> ⚠ Semakin banyak akun = semakin banyak request. 3–4 akun masih wajar;
> jangan berlebihan biar akun tidak kena batasan dari server.

## Scanner SP (`--sp`)

Tiap barang (terutama kategori **高爆赏/SP**) punya histori undian: berapa
**roll tanpa SP** (jumlah beli/roll sejak SP terakhir keluar) dan **avg rolls**
(rata-rata roll antar SP, dihitung dari ~20 SP terakhir). Kalau roll tanpa SP
sudah **melewati rata-rata**, SP-nya "jatuh tempo" — chance dapat SP naik
signifikan. Bot membaca data ini langsung dari API:

- `POST /goods/guaranteeDetail` → `sales_num_sp` (roll tanpa SP sekarang)
- `POST /goods/dataAnalysis/sp` → `average_info.sale_num_total` (avg rolls)

Jalankan `node bot.mjs --sp` kapan saja untuk laporan semua barang (diurutkan
yang paling "jatuh tempo" di atas, ditandai 🔥), dikirim juga ke notif HP.
Untuk cek otomatis berkala, set `spCheckHours` di config (mis. `1` = tiap jam)
— bot akan kirim notif `🔥 Boxkia: SP jatuh tempo` begitu ada barang yang
melewati rata-ratanya (dan berhenti mengirim setelah SP-nya keluar / reset).

> ℹ️ Ini hanya **deteksi timing** (kapan chance SP naik) — bot tidak otomatis
> membeli roll. Beli roll butuh saldo; kalau mau, tinggal buka barangnya di
> aplikasi dan roll saat notif 🔥 muncul.

## Monitor SP otomatis (`sp-watch.mjs`)

Tool **terpisah** yang jalan sendiri (tidak perlu bot event). Setiap beberapa
menit dia scan semua barang SP dan **langsung kirim notif ntfy** begitu ada
barang yang "roll tanpa SP"-nya sudah **mendekati rata-rata** (⚠️) atau
**melewati rata-rata** (🔥), dan kabar kalau SP-nya keluar (✅ gap reset).

```bash
node sp-watch.mjs           # jalan terus — biarkan terminal ini terbuka
node sp-watch.mjs --once    # scan sekali, notif status sekarang, keluar
node sp-watch.mjs --reset   # hapus state (biar notif ulang dari awal)
```

Config tambahan di `config.json` (semuanya opsional):

| Key | Arti |
|-----|------|
| `spWatchIntervalMs` | Jeda scan (default `300000` = tiap 5 menit) |
| `spApproachPct` | % dari rata-rata untuk trigger notif ⚠️ "mendekati" (default `80`) |

State tiap barang disimpan di `sp-watch-state.json` — jadi kalau tool
ke-restart, dia tidak notif ulang barang yang sudah pernah dilaporkan
(anti-spam). Hapus file itu (atau pakai `--reset`) kalau mau mulai dari nol.

> ℹ️ Tool ini juga hanya **deteksi & notif** — dia tidak membeli roll. Karena
> scan butuh ~100+ request tiap siklus, jangan set `spWatchIntervalMs` terlalu
> kecil (di bawah 1 menit tidak disarankan).

## Yang perlu kamu tahu

- **Angpao (type 1) tidak selalu gratis.** Tiap event punya syarat:
  - Angpao: harus sudah **belanja hari ini ≥ `limit_price`** (mis. 100).
  - Free box (type 0): harus **level ≥ `level_limit`** (mis. LV10).
  Bot menampilkan tanda `✓`/`✗` di jadwal supaya kamu tahu event mana yang bisa
  kamu ikuti. Kalau belum memenuhi syarat, server akan menolak join.
- **Jadwal berubah tiap hari** dan ada beberapa event per hari (bukan cuma jam
  10 pagi / 9 malam). Bot otomatis mengejar semua event target yang tersisa,
  jadi tinggal biarkan jalan.
- **Undian terjadi saat kuota penuh.** Join sukses = nomormu masuk pool;
  hasil/uangnya terlihat setelah event selesai (cek di aplikasi Boxkia).
- Waktu dihitung dari countdown server (`diff_time_start`), jadi zona waktu
  perangkatmu tidak memengaruhi akurasi tembakan.
- **Syarat & ketentuan:** memakai bot untuk event seperti ini berpotensi
  melanggar ToS / aturan "keadilan" Boxkia, dan risiko akun dibatasi adalah
  milikmu. Pakai sewajarnya (bukan banjir ribuan request per detik).
