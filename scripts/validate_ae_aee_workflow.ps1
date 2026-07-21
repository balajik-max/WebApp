$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "=== Build backend and frontend ===" -ForegroundColor Cyan
docker compose build backend frontend
if ($LASTEXITCODE -ne 0) { throw "Docker build failed." }

Write-Host "=== Recreate only application containers ===" -ForegroundColor Cyan
docker compose up -d --no-deps --force-recreate backend frontend
if ($LASTEXITCODE -ne 0) { throw "Application container recreation failed." }

Start-Sleep -Seconds 25

docker compose ps

Write-Host "=== API health ===" -ForegroundColor Cyan
Invoke-RestMethod -Uri "http://localhost:8001/api/health" -TimeoutSec 30 | ConvertTo-Json -Depth 5

Write-Host "=== Frontend health ===" -ForegroundColor Cyan
$frontendStatus = (Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:3000" -TimeoutSec 30).StatusCode
if ($frontendStatus -ne 200) { throw "Frontend returned HTTP $frontendStatus" }
Write-Host "Frontend HTTP 200" -ForegroundColor Green

Write-Host "=== Workflow contract tests ===" -ForegroundColor Cyan
docker compose exec -T backend python -m unittest tests.test_direct_remediation_workflow -v
if ($LASTEXITCODE -ne 0) { throw "Workflow contract tests failed." }

Write-Host "=== Rollback-only live workflow transaction ===" -ForegroundColor Cyan
docker compose exec -T backend python -m tests.run_live_remediation_transaction
if ($LASTEXITCODE -ne 0) { throw "Live remediation transaction failed." }

Write-Host "=== RBAC and read-only regression probes ===" -ForegroundColor Cyan
docker compose exec -T backend python -m tests.run_live_authorization
if ($LASTEXITCODE -ne 0) { throw "Authorization/regression probes failed." }

Write-Host "=== Isolated upload smoke test ===" -ForegroundColor Cyan
docker compose exec -T backend python -m tests.run_live_upload_smoke
if ($LASTEXITCODE -ne 0) { throw "Upload smoke test failed." }

Write-Host "=== Recent backend errors ===" -ForegroundColor Cyan
$errors = docker compose logs --no-color --since=15m backend | Select-String -Pattern "ERROR|Traceback|Internal Server Error| 500 "
if ($errors) {
    $errors
    throw "Recent backend errors were found. Review before committing."
}

Write-Host "PASS: AE -> AEE -> Commissioner workflow and representative existing features validated." -ForegroundColor Green
Write-Host "No Docker volumes were deleted by this script." -ForegroundColor Green
