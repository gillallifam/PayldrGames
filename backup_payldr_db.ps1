# ================================================================
# SCRIPT DE BACKUP: BAIXAR BANCO DE DADOS PAYLDR (REMOTO -> LOCAL)
# Destino: C:\apps\PayldrGames\payldr.db
# ================================================================

$ErrorActionPreference = "Stop"

$localDestDir = "C:\apps\PayldrGames"
$localDbFile = Join-Path $localDestDir "payldr.db"

$remoteUser = "ubuntu"
$remoteHost = "144.22.213.47"
$remoteDbPath = "/home/ubuntu/dev/payldr/payldr.db"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   BACKUP DO BANCO DE DADOS PAYLDR (PRODUCAO)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# 1. Localizar chave SSH
Write-Host "Procurando chave SSH..." -ForegroundColor Yellow
$keyFile = Get-ChildItem -Path "C:\Users\gilla\OneDrive" -Filter "ssh-key-2021-12-10.key" -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $keyFile) {
    $keyFile = Get-ChildItem -Path $env:USERPROFILE -Filter "ssh-key-2021-12-10.key" -Recurse -Depth 5 -ErrorAction SilentlyContinue | Select-Object -First 1
}

if (-not $keyFile) {
    Write-Host "[ERRO] Chave SSH 'ssh-key-2021-12-10.key' nao encontrada!" -ForegroundColor Red
    exit 1
}

$keyPath = $keyFile.FullName
Write-Host "Chave SSH encontrada: $keyPath" -ForegroundColor Green

# 2. Garantir que a pasta de destino local exista
if (-not (Test-Path $localDestDir)) {
    Write-Host "Criando pasta de destino local '$localDestDir'..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $localDestDir -Force | Out-Null
}

# 3. Forçar checkpoint no SQLite no servidor (para consolidar WAL no arquivo principal .db)
Write-Host "Sincronizando WAL no servidor remoto..." -ForegroundColor Yellow
& ssh -i "$keyPath" "$remoteUser@$remoteHost" "sqlite3 $remoteDbPath 'PRAGMA wal_checkpoint(TRUNCATE);'"

# 4. Baixar o arquivo via stream SSH (100% compativel com Windows e sem problemas de pipe do scp)
Write-Host "Baixando '$remoteDbPath' para '$localDbFile'..." -ForegroundColor Yellow
cmd.exe /c "ssh -i `"$keyPath`" $remoteUser@$remoteHost `"cat $remoteDbPath`" > `"$localDbFile`""

if ($LASTEXITCODE -eq 0 -and (Test-Path $localDbFile)) {
    $fileSize = (Get-Item $localDbFile).Length
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host " [SUCESSO] Banco de dados baixado com sucesso!" -ForegroundColor Green
    Write-Host " Arquivo: $localDbFile" -ForegroundColor Cyan
    Write-Host " Tamanho: $([math]::Round($fileSize / 1KB, 2)) KB" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Green
} else {
    Write-Host "[ERRO] Falha ao baixar banco de dados do servidor." -ForegroundColor Red
    exit 1
}
