#!/usr/bin/env bash
# Jalankan bot event Boxkia (Linux/VPS). Untuk manual:
#   bash run-boxkia.sh
# Untuk auto-restart + auto-start saat boot, pakai systemd (lihat MIGRASI.md).
cd "$(dirname "$0")" || exit 1
export TZ=Asia/Jakarta
exec node bot.mjs
