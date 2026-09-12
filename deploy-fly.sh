#!/usr/bin/env bash
# deploy-fly.sh — deploy bot event Boxkia ke Fly.io (region Singapore).
# Versi bash dari deploy-fly.ps1; aman dijalankan berulang.
#
# Prasyarat (sekali saja):
#   1. Akun Fly + metode pembayaran terdaftar (tidak ada free tier untuk akun baru).
#   2. flyctl terinstall:  curl -L https://fly.io/install.sh | sh
#   3. Sudah login:        fly auth login
set -euo pipefail

APP=boxkia-bot
REGION=sin
VOLUME=boxkia_data

step() { printf '\n==> %s\n' "$1"; }
warn() { printf '!! %s\n' "$1" >&2; }

step 'Cek flyctl'
if ! command -v flyctl >/dev/null 2>&1 && ! command -v fly >/dev/null 2>&1; then
  if [ -x "$HOME/.fly/bin/flyctl" ]; then
    PATH="$HOME/.fly/bin:$PATH"
  else
    warn 'flyctl belum terinstall. Jalankan: curl -L https://fly.io/install.sh | sh'
    exit 1
  fi
fi
FLY=$(command -v flyctl || command -v fly)
echo "  flyctl: $FLY"

step 'Cek login Fly'
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  warn 'Belum login ke Fly. Jalankan: fly auth login'
  exit 1
fi

step "Pastikan app '$APP' ada"
if "$FLY" apps list --json 2>/dev/null | grep -q "\"$APP\""; then
  echo '  app sudah ada'
else
  "$FLY" apps create "$APP"
fi

step "Pastikan volume '$VOLUME' ada di region $REGION"
if "$FLY" volumes list -a "$APP" --json 2>/dev/null | grep -q "\"$VOLUME\""; then
  echo '  volume sudah ada'
else
  "$FLY" volumes create "$VOLUME" --region "$REGION" --size 1 --yes
fi

step 'Deploy (build image + push + start machine)'
"$FLY" deploy --ha=false

step 'Status machine'
"$FLY" status -a "$APP"

cat <<'MSG'

==> Langkah terakhir (WAJIB): matikan bot event di GitHub Actions
  Supaya bot Actions nggak ikut nembak join di event yang sama, set repo variable:

    GitHub → Settings → Secrets and variables → Actions → Variables
    → New repository variable → Name: BOXKIA_FLY_ACTIVE  Value: true

    (atau: gh variable set BOXKIA_FLY_ACTIVE --body true)

  Monitor SP tetap jalan di Actions — itu nggak butuh latensi rendah.
MSG
