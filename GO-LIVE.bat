@echo off
REM == OptionDecay's The Rush — start the server + public tunnel ==
REM Double-click this file. Keep BOTH windows open and your PC awake
REM for the site to stay reachable. Close the windows to take it offline.

cd /d "%~dp0"
set TRUST_PROXY=1
set ADMIN_EMAIL=mail@mail.com
set ONE_ACCOUNT_PER_IP=1

start "The Rush - server" cmd /k node server.js
timeout /t 2 >nul

echo.
echo ================================================================
echo  Your public link will appear below as a trycloudflare.com URL.
echo  Share that link. (It changes each time you run this script.)
echo ================================================================
echo.
cloudflared.exe tunnel --url http://localhost:3000 --no-autoupdate
