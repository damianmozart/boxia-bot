@echo off
rem Jalankan monitor SP Boxkia (sp-watch.mjs) — notif otomatis saat SP mendekati/melewati rata-rata.
rem Sebelum start, matikan instance watcher lama yang masih jalan biar tidak dobel.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*sp-watch.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
cd /d "C:\home\user\boxkia-bot"
"C:\Program Files\nodejs\node.exe" sp-watch.mjs
