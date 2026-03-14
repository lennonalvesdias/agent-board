# ══════════════════════════════════════════════════════════════════════
#  AgentBoard v2 — Inicialização (Windows / PowerShell)
#  Garante que o opencode serve está rodando antes do Orchestrator.
# ══════════════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   AgentBoard v2 — Startup (Windows)      ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── 1. Pré-requisitos ─────────────────────────────────────────────────
function Check-Command($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "❌ '$cmd' não encontrado no PATH." -ForegroundColor Red
        Write-Host "   $hint"
        exit 1
    }
    Write-Host "✓ $cmd" -ForegroundColor Green
}

Check-Command "node"     "Instale em: https://nodejs.org"
Check-Command "opencode" "Instale conforme a documentação do OpenCode."

$nodeVersion = (node -e "process.stdout.write(process.versions.node.split('.')[0])")
if ([int]$nodeVersion -lt 18) {
    Write-Host "❌ Node.js muito antigo ($(node --version)). Mínimo: v18." -ForegroundColor Red
    exit 1
}

# ── 2. .env ───────────────────────────────────────────────────────────
Set-Location $ROOT
if (-not (Test-Path ".env")) {
    Write-Host ""
    Write-Host "⚠  .env não encontrado — criando a partir do .env.example..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host "   ➜  Preencha ADO_ORG, ADO_PROJECT e ADO_PAT no arquivo .env" -ForegroundColor Yellow
    Write-Host "   ➜  Depois execute este script novamente." -ForegroundColor Yellow
    exit 1
}

# Carrega .env como hashtable
$env_vars = @{}
Get-Content ".env" | Where-Object { $_ -match "^[A-Z]" } | ForEach-Object {
    $parts = $_ -split "=", 2
    if ($parts.Count -eq 2) { $env_vars[$parts[0].Trim()] = $parts[1].Trim() }
}

$MISSING = @()
foreach ($k in @("ADO_ORG","ADO_PROJECT","ADO_PAT")) {
    if (-not $env_vars[$k] -or $env_vars[$k] -match "cole_") { $MISSING += $k }
}
if ($MISSING.Count -gt 0) {
    Write-Host "❌ Variáveis não preenchidas no .env:" -ForegroundColor Red
    $MISSING | ForEach-Object { Write-Host "   - $_" }
    exit 1
}
Write-Host "✓ .env OK" -ForegroundColor Green

$PORT = if ($env_vars["OPENCODE_PORT"]) { $env_vars["OPENCODE_PORT"] } else { "4096" }
$WORKSPACE = if ($env_vars["WORKSPACE_ROOT"]) { $env_vars["WORKSPACE_ROOT"] } else { "$env:USERPROFILE\repos" }

# ── 3. Copia opencode.json e AGENTS.md para o workspace ──────────────
Write-Host ""
Write-Host "📋 Copiando configurações OpenCode para: $WORKSPACE" -ForegroundColor Cyan
if (Test-Path $WORKSPACE) {
    Copy-Item "$ROOT\opencode-config\opencode.json" "$WORKSPACE\opencode.json" -Force
    Write-Host "  ✓ opencode.json" -ForegroundColor Green
    Copy-Item "$ROOT\opencode-config\AGENTS.md" "$WORKSPACE\AGENTS.md" -Force
    Write-Host "  ✓ AGENTS.md" -ForegroundColor Green
} else {
    Write-Host "  ⚠ WORKSPACE_ROOT ($WORKSPACE) não existe — copie manualmente os arquivos de opencode-config/" -ForegroundColor Yellow
}

# ── 4. Dependências ───────────────────────────────────────────────────
if (-not (Test-Path "node_modules")) {
    Write-Host ""; Write-Host "📦 Instalando dependências..." -ForegroundColor Cyan
    npm install
}
Write-Host "✓ Dependências OK" -ForegroundColor Green

# ── 5. opencode serve ─────────────────────────────────────────────────
Write-Host ""
Write-Host "🔌 Verificando opencode serve na porta $PORT..." -ForegroundColor Cyan

$servePID = $null
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$PORT/global/health" -TimeoutSec 2
    Write-Host "✓ opencode serve já está rodando." -ForegroundColor Green
} catch {
    Write-Host "  → Iniciando opencode serve em background..." -ForegroundColor Cyan
    $env:OPENCODE_SERVER_PORT = $PORT
    $proc = Start-Process "opencode" -ArgumentList "serve","--port",$PORT `
        -RedirectStandardOutput "$ROOT\opencode-serve.log" `
        -RedirectStandardError  "$ROOT\opencode-serve-err.log" `
        -PassThru -WindowStyle Hidden
    $servePID = $proc.Id
    Write-Host "  → PID: $servePID (log: opencode-serve.log)" -ForegroundColor Gray

    Write-Host -NoNewline "  → Aguardando health check"
    $ok = $false
    for ($i = 1; $i -le 15; $i++) {
        Start-Sleep 1
        Write-Host -NoNewline "."
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$PORT/global/health" -TimeoutSec 1 | Out-Null
            $ok = $true; break
        } catch {}
    }
    Write-Host ""
    if (-not $ok) {
        Write-Host "❌ opencode serve não respondeu em 15s. Verifique opencode-serve.log" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ opencode serve respondendo." -ForegroundColor Green
}

# ── 6. Dashboard ──────────────────────────────────────────────────────
$dashboard = "$ROOT\dashboard\index.html"
if (Test-Path $dashboard) {
    Write-Host ""; Write-Host "🌐 Abrindo dashboard..." -ForegroundColor Cyan
    Start-Process $dashboard
}

# ── 7. Orchestrator ───────────────────────────────────────────────────
Write-Host ""; Write-Host "🚀 Iniciando Orchestrator... (Ctrl+C para parar)" -ForegroundColor Green; Write-Host ""

try {
    npm run dev
} finally {
    if ($servePID) {
        Write-Host ""; Write-Host "Encerrando opencode serve (PID $servePID)..." -ForegroundColor Yellow
        Stop-Process -Id $servePID -Force -ErrorAction SilentlyContinue
    }
}
