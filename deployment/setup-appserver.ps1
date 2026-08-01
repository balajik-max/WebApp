# setup-appserver.ps1
# Run this on EACH App Server PC

param(
    [string]$DBServerIP = "192.168.10.81"
)

$PROJECT_PATH = "D:\davangere"  # Where you copied the project

Write-Host "=== App Server Setup ===" -ForegroundColor Cyan
Write-Host "DB Server IP: $DBServerIP" -ForegroundColor Yellow

# Step 1: Create .env for app server
Write-Host "`n[1/4] Creating .env file..." -ForegroundColor Yellow
@"
# App Server Environment
DATABASE_URL=postgresql://postgres:jvpiLtvqdqqSZ1HdBVEgokQk8Bzww@${DBServerIP}:5432/davangere_urban
REDIS_URL=redis://redis:6379/0
SECRET_KEY=your-secret-key-change-this
OLLAMA_BASE_URL=http://ai_engine:11434
MINIO_ENDPOINT=http://${DBServerIP}:9000
OLLAMA_MODEL=llama3.2
"@ | Set-Content "$PROJECT_PATH\.env"

# Step 2: Build and start
Write-Host "`n[2/4] Building and starting services..." -ForegroundColor Yellow
Push-Location $PROJECT_PATH
docker compose -f docker-compose.appserver.yml up -d --build
Pop-Location

# Step 3: Wait for AI engine to be ready
Write-Host "`n[3/4] Waiting for AI engine..." -ForegroundColor Yellow
Start-Sleep -Seconds 30

# Step 4: Verify
Write-Host "`n[4/4] Checking status..." -ForegroundColor Yellow
docker ps

Write-Host "`n=== App Server Ready! ===" -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend API: http://localhost:8001"
Write-Host "AI Engine: http://localhost:11434"
