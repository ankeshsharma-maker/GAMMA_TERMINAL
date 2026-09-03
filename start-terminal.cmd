@echo off
title GammaTerminal Launcher
setlocal
set "ROOT=%~dp0"

echo ============================================
echo   Starting GammaTerminal
echo ============================================
echo.

REM --- First-run setup if dependencies are missing ---
if not exist "%ROOT%backend\.venv\Scripts\python.exe" (
    echo [setup] Creating Python virtual env ...
    pushd "%ROOT%backend"
    python -m venv .venv || goto :err
    .venv\Scripts\python.exe -m pip install -r requirements.txt || goto :err
    popd
)
if not exist "%ROOT%frontend\node_modules" (
    echo [setup] Installing frontend packages ...
    pushd "%ROOT%frontend"
    call npm install || goto :err
    popd
)

echo [1/3] Backend  -^> http://localhost:8000
start "GammaTerminal Backend" cmd /k "pushd "%ROOT%backend" && .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000"

echo [2/3] Frontend -^> http://localhost:5173
start "GammaTerminal Frontend" cmd /k "pushd "%ROOT%frontend" && npm run dev"

echo [3/3] Waiting for servers to come up ...
ping -n 11 127.0.0.1 >nul

start "" "http://localhost:5173"

echo.
echo GammaTerminal is running. Two server windows opened.
echo Close those windows, or run stop-terminal.cmd, to shut it down.
ping -n 5 127.0.0.1 >nul
exit /b 0

:err
echo.
echo Setup failed. See the messages above.
pause
exit /b 1
