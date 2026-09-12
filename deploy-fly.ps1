# deploy-fly.ps1 — deploy bot event Boxkia ke Fly.io (region Singapore).
# Aman dijalankan berulang: app & volume dibuat sekali, sisanya cuma re-deploy.
#
# Pakai:
#   powershell -ExecutionPolicy Bypass -File deploy-fly.ps1
#
# Prasyarat (sekali saja):
#   1. Punya akun Fly + metode pembayaran terdaftar (Fly tidak punya free tier
#      untuk akun baru lagi — perkiraan ±$2/bulan untuk bot ini).
#   2. flyctl terinstall:  iwr https://fly.io/install.ps1 -useb | iex
#   3. Sudah login:        fly auth login

$ErrorActionPreference = 'Stop'
$App = 'boxkia-bot'
$Region = 'sin'
$Volume = 'boxkia_data'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Warn($text) { Write-Host "!! $text" -ForegroundColor Yellow }

# --- 1. flyctl ada? -----------------------------------------------------------
Step 'Cek flyctl'
$fly = Get-Command flyctl -ErrorAction SilentlyContinue
if (-not $fly) {
  # Instalasi default menaruh flyctl di %USERPROFILE%\.fly\bin
  $fallback = Join-Path $env:USERPROFILE '.fly\bin\flyctl.exe'
  if (Test-Path $fallback) { $fly = $fallback } else {
    Warn 'flyctl belum terinstall. Jalankan dulu:'
    Write-Host '   iwr https://fly.io/install.ps1 -useb | iex'
    Write-Host '   (tutup & buka ulang PowerShell, lalu jalankan skrip ini lagi)'
    exit 1
  }
}
Write-Host "  flyctl: $fly"

# --- 2. Sudah login? ---------------------------------------------------------
Step 'Cek login Fly'
& $fly auth whoami 2>$null
if ($LASTEXITCODE -ne 0) {
  Warn 'Belum login ke Fly. Jalankan:  fly auth login'
  exit 1
}

# --- 3. App ------------------------------------------------------------------
Step "Pastikan app '$App' ada"
$apps = @()
try { $apps = & $fly apps list --json 2>$null | ConvertFrom-Json } catch { }
if (@($apps.Name) -contains $App) {
  Write-Host '  app sudah ada'
} else {
  & $fly apps create $App
}

# --- 4. Volume (tempat log & state persist, biar nggak hilang tiap deploy) ----
Step "Pastikan volume '$Volume' ada di region $Region"
$vols = @()
try { $vols = & $fly volumes list -a $App --json 2>$null | ConvertFrom-Json } catch { }
if (@($vols.Name) -contains $Volume) {
  Write-Host '  volume sudah ada'
} else {
  & $fly volumes create $Volume --region $Region --size 1 --yes
}

# --- 5. Deploy ---------------------------------------------------------------
Step 'Deploy (build image + push + start machine)'
& $fly deploy --ha=false
if ($LASTEXITCODE -ne 0) { Warn 'Deploy gagal — cek output di atas.'; exit 1 }

# --- 6. Verifikasi -----------------------------------------------------------
Step 'Status machine'
& $fly status -a $App

Step 'Contoh log (10 baris terakhir)'
Start-Sleep -Seconds 5
& $fly logs -a $App --no-tail 2>$null | Select-Object -Last 10

# --- 7. Matikan bot Actions biar nggak dobel --------------------------------
Step 'Langkah terakhir (WAJIB): matikan bot event di GitHub Actions'
Write-Host @"
  Bot Fly sekarang yang jalan 24/7. Supaya bot Actions nggak ikut nembak join
  di event yang sama, set repo variable ini:

    GitHub → Settings → Secrets and variables → Actions → tab Variables
    → New repository variable → Name: BOXKIA_FLY_ACTIVE  Value: true

  (Atau lewat gh CLI:  gh variable set BOXKIA_FLY_ACTIVE --body true )

  Monitor SP tetap jalan di Actions — itu nggak butuh latensi rendah.
  Untuk balik ke Actions: hapus variabel BOXKIA_FLY_ACTIVE, lalu
  `fly apps destroy $App`.
"@ -ForegroundColor Green
