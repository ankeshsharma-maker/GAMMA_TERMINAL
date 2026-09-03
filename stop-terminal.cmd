@echo off
title GammaTerminal - Stop
echo Stopping GammaTerminal ...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ids = @(); foreach ($p in 8000,5173) { $ids += (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue).OwningProcess }; $ids += (Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='node.exe'\" | Where-Object { $_.CommandLine -match 'TERMINAL NEW|uvicorn app.main|multiprocessing-fork|run\.py' }).ProcessId; $ids | Where-Object { $_ } | Select-Object -Unique | ForEach-Object { Write-Host ('  killing PID ' + $_); taskkill /F /T /PID $_ 2>$null | Out-Null }"

echo Done.
ping -n 3 127.0.0.1 >nul
exit /b 0
