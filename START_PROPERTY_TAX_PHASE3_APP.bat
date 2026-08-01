@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>&1
if errorlevel 1 (
  echo Docker is not available. Start Docker Desktop and run this file again.
  pause
  exit /b 1
)
if not exist .env (
  echo The root .env file is missing. Copy your existing working .env into this folder.
  pause
  exit /b 1
)
docker compose up -d --build
if errorlevel 1 (
  echo The application could not be started. Review the Docker output above.
  pause
  exit /b 1
)
timeout /t 8 /nobreak >nul
start "" "http://localhost:3000/map"
echo Property Tax Phase 3.1 GIS Auto-fill is available at http://localhost:3000/map
pause
endlocal
