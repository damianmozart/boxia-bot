#!/usr/bin/env bash
# ⚡ Setup one-shot Boxkia bot di VPS Ubuntu (18.04/20.04/22.04/24.04).
#
# Cara pakai di server:
#   1. Upload boxkia-bot-migrasi.zip ke home kamu (scp / console web)
#   2. sudo apt-get install -y unzip
#   3. unzip boxkia-bot-migrasi.zip && cd boxkia-bot
#   4. bash setup-vps.sh
#
# Script ini: install Node.js (kalau belum ada), tes token, lalu pasang
# systemd services (auto-start saat boot + auto-restart kalau crash).
set -e
cd "$(dirname "$0")"

echo "==> 1/4 Cek Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "    Node belum terinstall — install NodeSource 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "    ❌ Node terlalu lama ($(node -v)) — butuh 18+. Install manual dari https://nodejs.org"
  exit 1
fi
echo "    ✅ $(node -v)"

echo "==> 2/4 Tes token akun (harusnya Login OK 9 akun)"
if ! node bot.mjs --check; then
  echo "    ❌ Tes gagal — cek config.json (token) atau coba lagi."
  exit 1
fi

echo "==> 3/4 Pasang systemd services (path disesuaikan ke: $(pwd))"
SERVICE_DIR="$(pwd)"
sed "s|/home/user/boxkia-bot|$SERVICE_DIR|g" boxkia.service | sudo tee /etc/systemd/system/boxkia.service > /dev/null
sed "s|/home/user/boxkia-bot|$SERVICE_DIR|g" boxkia-sp-watch.service | sudo tee /etc/systemd/system/boxkia-sp-watch.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now boxkia boxkia-sp-watch

echo "==> 4/4 Status services"
sleep 4
systemctl --no-pager --lines=8 status boxkia boxkia-sp-watch || true

echo ""
echo "✅ Selesai! Bot + SP watcher jalan otomatis."
echo "   Cek log:  journalctl -u boxkia -n 50"
echo "   Stop:     sudo systemctl stop boxkia boxkia-sp-watch"
echo "   Start:    sudo systemctl start boxkia boxkia-sp-watch"
echo "   ⚠️  JANGAN jalankan bot di laptop utama sekaligus — pilih satu tempat saja."
