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
node bot.mjs --check      # cek token + lihat jadwal hari ini, lalu keluar
node bot.mjs --saldo      # tampilkan saldo & poin tiap akun, lalu keluar
node bot.mjs --sp         # scan barang SP: "roll tanpa SP" vs "avg rolls" (due checker), lalu keluar
node bot.mjs --hasil      # kirim laporan hasil undian event terakhir (posisi + dapat berapa)
node bot.mjs --hasil 244  # laporan event tertentu (id dari kolom jadwal)
node bot.mjs --notif-test # kirim 1 notif tes ke HP, buat memastikan jalur notif sehat
node bot.mjs              # jalan terus — biarkan terminal ini terbuka
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
| `joinConcurrency` | Maksimum request `join` yang *in flight* per akun (default 3). Request diluncurkan satu-satu tiap `retryIntervalMs` tanpa menunggu balasan, jadi kedatangannya tersebar — bukan menggerombol lalu nganggur sepanjang RTT |
| `joinTimeoutMs` | Timeout tiap request join (default 3000 ms) — harus < `retryMaxMs` supaya satu request macet tidak menelan seluruh burst |
| `retryIntervalMs` | Jeda antar putaran tembakan di dalam burst (default 120 ms) |
| `retryMaxMs` | Lama maksimal burst (default 8000 ms) |
| `freeBoxDelayMs` | **Free box (type 0) saja**: kapan join-nya *mendarat* di server, dihitung dari waktu mulai (default 1000). Tujuannya supaya masuk di posisi ~20-an/30-an, bukan juara 1. Set `0` kalau mau ikut ngebut juga |
| `freeBoxDelayJitterMs` | Tambahan acak 0..X ms untuk free box (default 300), biar posisinya tidak selalu persis sama |
| `postFireCooldownMs` | Jeda santai setelah selesai nembak (default 1500 ms) — biar request jadwal berikutnya tidak ikut rebutan di detik kritis. Otomatis dipangkas kalau ada event lain yang sudah di-arm |
| `actionsBudgetMs` | Mode `--actions`: lama satu run bertahan (default 600000 = 10 menit). **Wajib > jeda tick cron** supaya tiap event pasti ketangkep |
| `apiTimeoutMs` | Timeout tiap request API (default 15000 ms) — mencegah fetch yang macet membekukan bot |
| `ntfyTopic` | Topic ntfy.sh (opsional) untuk notifikasi ke HP saat berhasil/gagal, plus laporan hasil undian setelah event selesai (`💰 …: N akun dapat Rp …` atau `📊 … belum ada yang dapat`) berisi posisi tiap akun (`posisi N/total`), jam join relatif ke waktu mulai (`T+0s`), dan **berapa yang didapat masing-masing** — dan laporan saldo (`💰 Saldo …`) saat bot start & tiap heartbeat |
| `waitResultMs` | Setelah nembak, bot menunggu hasil undian muncul lalu mengirim laporan posisi + berapa yang didapat (default 180000 = 3 menit). Laporan dikirim **menang maupun tidak** — bisa dipicu manual dengan `node bot.mjs --hasil`. Kalau record hari itu belum ada, bot **menunggu dan mencoba lagi**, bukan memakai record hari lain |
| `spCheckHours` | **Scanner SP otomatis** — kalau > 0 (mis. `1`), bot mengecek tiap X jam apakah ada barang yang SP-nya "jatuh tempo" (roll tanpa SP sudah melewati rata-rata) dan kirim notif `🔥` ke ntfy. Default `0` = mati |
| `dailyScheduleHour` | Jam (0–23) kirim **ringkasan jadwal hari ini** (`📅`) ke ntfy — daftar event + akun mana yang memenuhi syarat (elig). Default `0` = tengah malam. Bisa kirim manual kapan saja dengan `node bot.mjs --jadwal` |
| `freeBoxTargets` | Daftar nama akun yang ikut **Daily Free Blind Box** (harus ada di `accounts`). Default: `West said, Femzy, Boxkia 27895, syawarman` |
| `freeBoxCheckMin` | Menit antar cek **Daily Free Blind Box** (akun target) dari laptop ini — default `15`, `0` = matikan. Bot sudah hidup terus, jadi box-nya tetap terambil walau GitHub Actions sedang outage. Script-nya idempoten (hanya draw kalau statusnya benar-benar siap), jadi aman jalan dobel bareng cloud |

Kalau sudah sering "kehabisan", naikkan `joinConcurrency` ke `3` dan kecilkan
`retryIntervalMs` ke `80`. Jangan terlalu agresif — kalau ketahuan membanjiri
server, akun bisa kena batasan.

> **Angpao vs free box — angkanya dari data peserta asli.**
> `node analyze-participants.mjs` membaca daftar peserta event yang sudah lewat
> (`join_date` + `sale_num`) dan mencetak seberapa cepat kuotanya terisi.
>
> Hasil dari event angpao #244: **89 dari 100 slot terisi di detik ke-0**, sisanya
> habis di detik ke-1 — jadi angpao murni balapan sub-detik dan harus ditembak
> presisi saat event dibuka. Hasil dari free box #275 (70 slot): **21 orang di
> detik ke-0, +15 di detik ke-1**, baru penuh pelan sampai detik ke-30-an — jadi
> free box cukup datang sekitar 1 detik setelah mulai untuk dapat posisi 20-an/30-an.
>
> Angka-angka itu yang jadi dasar default `freeBoxDelayMs: 1000` dan lead
> presisi untuk angpao. Kalau pola peserta berubah, jalankan lagi
> `analyze-participants.mjs` lalu sesuaikan.

> **Arti "dapat berapa" di laporan hasil undian** (jangan ketuker — dua tipe event
> ini beda aturan):
> - **Angpao (type 1):** kolam (`price`) dibagi ke **semua** peserta. Tiap peserta
>   dapat bagian acak, dan jumlah semua `amount` = `price`. Contoh angpao #244:
>   `price` 600.000 dibagi 100 peserta → dapat Rp 44 s/d Rp 17.057 per orang.
>   Jadi peserta angpao **selalu dapat**, `is_win = 1` cuma menandai bagian terbesar.
> - **Free box (type 0):** hadiah jatuh ke **satu** pemenang. Yang lain `amount` 0
>   (notifikasinya `dapat Rp 0` — memang benar).
>
> Karena itu laporan menghitung "didapat" dari `amount`, bukan dari `is_win`.

> **Jangan sampai laporan ketuker harinya.** Endpoint `luckyBag/record` memisahkan
> hasil per hari lewat `date_type` (`0` = hari ini, `1` = kemarin), sementara id
> event dipakai ulang tiap hari. Dulu bot mencoba `date_type=0` lalu **jatuh ke
> `date_type=1`** kalau record hari ini belum terisi — akibatnya notifikasi
> menampilkan **posisi & hasil kemarin** sebagai hasil event hari ini (posisi
> "1,11,5,4,13…" padahal yang benar "6,7,9,10,11…"). Sekarang bot memilih
> `date_type` dari waktu mulai event (`diff_time_start`) dan **menunggu lalu
> mencoba lagi** kalau record hari itu belum ada — tidak pernah memakai hari lain.
> Laporan juga menuliskan harinya secara eksplisit: `(hari ini)` / `(kemarin)`.

> **Arti tanda di daftar elig.** `✓` = memenuhi syarat, `✗` = tidak (level/belanja),
> dan **`!` = token akun itu tidak valid** — akun itu tidak ikut event mana pun.
> Dulu akun dengan token mati ditandai `✓` (karena data user-nya kosong, jadi
> dianggap memenuhi syarat) dan tiap event tetap ditembak, selalu balas `10003`.
> Sekarang token mati ditandai `!` dan tidak pernah ditembak.
>
> **Akun kembar dengan token mati dibuang otomatis.** Akun kembar bisa dikenali
> dari `user_id` — tapi kalau tokennya sudah mati, login-nya gagal sehingga
> `user_id`-nya tak diketahui. Karena itu bot juga mendeteksi **nickname yang sama
> dengan akun yang login sukses** dan membuang entri yang tokennya mati itu
> (log-nya menyebut `visitorId`-nya, mis. `boxkia-bot-1`, supaya gampang dicari
> di `config.json`). Sebelumnya entri basi ini membuang satu slot tembakan tiap
> event dan memunculkan baris kembar di laporan hasil undian.
>
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

### Akun khusus Daily Free Blind Box

`freeBoxTargets` menentukan siapa saja yang ikut *Daily Free Blind Box*
(sekarang: `West said`, `Femzy`, `Boxkia 27895`, `syawarman`).

Kalau ada akun yang **hanya** mau ikut *Daily Free Blind Box* — tidak ikut event
angpao/free-box treasure hunt — tambahkan `"freeBoxOnly": true` pada entri
akun itu:

```json
"freeBoxTargets": ["West said", "Femzy", "Boxkia 27895", "syawarman"],
"accounts": [
  { "name": "akun-baruy", "token": "TOKEN", "visitorId": "boxkia-bot-11", "freeBoxOnly": true }
]
```

Akun seperti ini tetap login (jadi ketahuan kalau tokennya mati), tapi
**dikecualikan** dari daftar eligibility event dan tidak pernah ikut menembak
join angpao/free-box event — dia cuma muncul di jalur `freebox-draw.mjs`
(`node freebox-draw.mjs --check` untuk lihat statusnya).

> `syawarman` (LV3) awalnya pakai flag ini, sekarang **dilepas** supaya dia ikut
> juga di event angpao/free-box — dia tetap terdaftar di `freeBoxTargets`, jadi
> dua-duanya kebagian.

### Sinkron config ke cloud (Secret GitHub)

`config.json` tidak di-commit (isinya token) dan repo ini publik, jadi GitHub
Actions mengambil config dari Secret `BOXKIA_CONFIG`. Kalau Secret-nya
ketinggalan, cloud jalan dengan daftar akun lama. Setelah mengubah `accounts`
atau `freeBoxTargets`, dorong perubahannya:

```bash
cd tools && npm install     # sekali saja (dependency libsodium)
node sync-cloud-config.mjs  # dari folder tools
```

Verifikasinya cuma lihat run Actions berikutnya: log-nya menyebut jumlah akun yang
login dan jumlah target Daily Free Box. (Kejadian nyata: akun `syawarman` sudah
aktif di laptop tapi cloud masih jalan dengan 3 akun free box karena Secret-nya
belum diperbarui.)

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
- **Anti-telat saat koneksi ngadat.** Server Boxkia sesekali menahan koneksi
  sampai timeout — terukur 9/9 request jadwal gagal bersamaan (22/9 20:41).
  Karena bot menembak dari data jadwal, kegagalan itu dulu berarti akun tidak
  punya target → tidak di-arm → baru menembak **setelah** event dibuka. Sekarang
  jadwal + kelayakan terakhir yang berhasil disimpan sebagai cadangan: kalau
  fetch gagal di jendela arm (20 detik terakhir), akun tetap di-arm dari data
  terakhir dan log-nya menandai `🛟 n akun di-arm dari jadwal terakhir`.
- **Syarat & ketentuan:** memakai bot untuk event seperti ini berpotensi
  melanggar ToS / aturan "keadilan" Boxkia, dan risiko akun dibatasi adalah
  milikmu. Pakai sewajarnya (bukan banjir ribuan request per detik).

## Tes

```bash
node test-arm-fire.mjs        # penjadwal ARM→FIRE + laporan hasil + judul notif + rescue (30 check)
node test-day-roll.mjs        # reset state "sudah ditembak" saat ganti hari (5 check)
node test-freebox-notify.mjs  # kebijakan notif free box (anti-spam & anti-alarm palsu) (6 check)
```

Id event Boxkia **dipakai ulang tiap hari** (angpao #244 muncul lagi besoknya).
Bot perlu membersihkan catatan "sudah ditembak" saat melewati tengah malam;
kalau tidak, proses yang hidup lebih dari sehari akan melewati semua event
yang id-nya sudah pernah ditembak — tanpa log. `test-day-roll.mjs` menjaga ini:
running pertama sengaja tanpa hook pergantian hari dan **harus** cuma menembak
sekali, running kedua dengan pergantian hari dipaksa dan **harus** menembak lagi.

Jaring pengaman arm (`🛟`) juga diuji dengan pola running control di
`test-arm-fire.mjs` run 4: mock-nya menahan koneksi jadwal tepat di jendela arm,
lalu bot dijalankan dua kali — **dengan** fix (harus tetap menembak tepat waktu)
dan **tanpa** fix lewat hook `BOXKIA_DISABLE_RESCUE_ARM` (harus tidak menembak
sama sekali). Tes itu merah kalau jaring pengamannya hilang dari kode.
