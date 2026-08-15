#!/usr/bin/env bash
# Jalankan monitor SP Boxkia (Linux/VPS). Untuk manual:
#   bash run-sp-watch.sh
# Untuk auto-restart + auto-start saat boot, pakai systemd (lihat MIGRASI.md).
cd "$(dirname "$0")" || exit 1
export TZ=Asia/Jakarta
exec node sp-watch.mjs
