@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 or newer is required: https://nodejs.org
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 24 or newer is required: https://nodejs.org
  pause
  exit /b 1
)

node scripts\stop.mjs %*
set "CC98_RESULT=%ERRORLEVEL%"
if not "%CC98_RESULT%"=="0" pause
exit /b %CC98_RESULT%
