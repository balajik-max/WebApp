# setup-worker.ps1 - Run this on each worker PC
# ==============================================
# Usage: .\setup-worker.ps1 -ManagerIP 192.168.10.94 -Token SWMTKN-1-xxxxx

param(
    [Parameter(Mandatory=$true)]
    [string]$ManagerIP,
    
    [Parameter(Mandatory=$true)]
    [string]$Token,
    
    [switch]$IsDBServer
)

$ErrorActionPreference = "Stop"

Write-Host "=== Setting up Worker Node ===" -ForegroundColor Cyan

# Join swarm
Write-Host "`n[1/2] Joining swarm..." -ForegroundColor Yellow
docker swarm join --token $Token ${ManagerIP}:2377

if ($IsDBServer) {
    Write-Host "`n[2/2] Labeling as DB server..." -ForegroundColor Yellow
    $hostname = hostname
    docker node update --label-add db=true $hostname
    Write-Host "  Labeled node '$hostname' with db=true" -ForegroundColor Green
}

Write-Host "`n=== Worker Ready! ===" -ForegroundColor Green
Write-Host "Verify on manager: docker node ls" -ForegroundColor Cyan
