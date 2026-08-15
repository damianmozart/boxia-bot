@echo off
rem Jalankan bot angpao Boxkia (multi-akun).
rem Sebelum start, matikan instance bot lama yang masih jalan biar tidak dobel.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bot.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
cd /d "C:\home\user\boxkia-bot"
"C:\Program Files\nodejs\node.exe" bot.mjs
