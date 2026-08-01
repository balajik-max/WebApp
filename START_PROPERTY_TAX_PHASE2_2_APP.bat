@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>&1
if errorlevel 1 (
  echo Docker is not available. Start Docker Desktop and run this file again.
  pause
  exit /b 1
)
docker compose up -d --build
if errorlevel 1 (
  echo The application could not be started. Review the Docker output above.
  pause
  exit /b 1
)
timeout /t 6 /nobreak >nul
start "" "http://localhost:3000/map"
echo Property Tax Phase 2.2 is available at http://localhost:3000/map
pause
endlocal
