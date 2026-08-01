param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$ExpectedBranch = "integration/public-portal-all-features-20260729"
)

$ErrorActionPreference = "Stop"

Set-Location $ProjectRoot

if (-not (Test-Path -LiteralPath ".git")) {
    throw "Not a Git repository: $ProjectRoot"
}

$branch = (git branch --show-current).Trim()
if ($branch -ne $ExpectedBranch) {
    throw "Wrong branch: $branch. Expected: $ExpectedBranch"
}

$privateTracked = git ls-files | Select-String '(^|/)(\.env|scratch_pw)(/|$)|\.tok$|\.pem$|\.key$|\.p12$|\.pfx$'
if ($privateTracked) {
    $privateTracked
    throw "Private files are tracked. Stop before build or push."
}

Write-Host "Building backend and frontend..." -ForegroundColor Cyan
docker compose build backend frontend

Write-Host "Starting services..." -ForegroundColor Cyan
docker compose up -d

docker compose ps

Write-Host "Checking backend health..." -ForegroundColor Cyan
Invoke-RestMethod "http://localhost:8001/api/health" | Out-Host
Invoke-RestMethod "http://localhost:8001/api/ready" | Out-Host

Write-Host "Checking frontend and API documentation..." -ForegroundColor Cyan
$frontend = Invoke-WebRequest "http://localhost:3000" -UseBasicParsing
$docs = Invoke-WebRequest "http://localhost:8001/api/docs" -UseBasicParsing

if ($frontend.StatusCode -ne 200) {
    throw "Frontend returned HTTP $($frontend.StatusCode)"
}
if ($docs.StatusCode -ne 200) {
    throw "API docs returned HTTP $($docs.StatusCode)"
}

Write-Host "Running public module validator..." -ForegroundColor Cyan
docker compose exec -T backend python scripts/validate_public_user_module.py

git diff --check

$forbidden = git status --porcelain | Select-String '(^|/)(\.env|scratch_pw)(/|$)|\.tok$|\.pem$|\.key$|\.p12$|\.pfx$|node_modules|dist|__pycache__|_installer|backup'
if ($forbidden) {
    $forbidden
    throw "Forbidden private/generated paths are present in Git status."
}

Write-Host "Automated local smoke checks passed." -ForegroundColor Green
Write-Host "Complete the manual role-by-role checklist before committing or pushing." -ForegroundColor Yellow
