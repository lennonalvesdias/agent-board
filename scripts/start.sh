#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
#  AgentBoard v2 — Inicialização (Mac / Linux)
#  Garante que o opencode serve está rodando antes do Orchestrator.
# ══════════════════════════════════════════════════════════════════════
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   AgentBoard v2 — Startup (Mac/Linux)    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Pré-requisitos ─────────────────────────────────────────────────
check() {
  if ! command -v "$1" &>/dev/null; then
    echo "❌ '$1' não encontrado no PATH."
    echo "   $2"
    exit 1
  fi
  echo "✓ $1"
}

check node    "Instale em: https://nodejs.org  ou  brew install node"
check opencode "Instale conforme a documentação do OpenCode."

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node.js $(node --version) — mínimo exigido: v18."
  exit 1
fi

# ── 2. .env ───────────────────────────────────────────────────────────
cd "$ROOT"
if [ ! -f ".env" ]; then
  echo ""
  echo "⚠  .env não encontrado — criando a partir do .env.example..."
  cp .env.example .env
  echo "   ➜  Preencha ADO_ORG, ADO_PROJECT e ADO_PAT no arquivo .env"
  echo "   ➜  Depois execute este script novamente."
  exit 1
fi

# Valida obrigatórias
source <(grep -E '^(ADO_ORG|ADO_PROJECT|ADO_PAT|OPENCODE_PORT)=' .env 2>/dev/null || true)
MISSING=()
[ -z "${ADO_ORG:-}"     ] && MISSING+=("ADO_ORG")
[ -z "${ADO_PROJECT:-}" ] && MISSING+=("ADO_PROJECT")
[ -z "${ADO_PAT:-}"     ] && MISSING+=("ADO_PAT")
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌ Variáveis não preenchidas no .env:"; for v in "${MISSING[@]}"; do echo "   - $v"; done
  exit 1
fi
echo "✓ .env OK"

PORT="${OPENCODE_PORT:-4096}"

# ── 3. Copia opencode.json e AGENTS.md para o workspace ──────────────
WORKSPACE="${WORKSPACE_ROOT:-$HOME/repos}"
echo ""
echo "📋 Copiando configurações OpenCode para: $WORKSPACE"
if [ -d "$WORKSPACE" ]; then
  cp "$ROOT/opencode-config/opencode.json" "$WORKSPACE/opencode.json" 2>/dev/null && echo "  ✓ opencode.json" || echo "  ⚠ Não foi possível copiar opencode.json"
  cp "$ROOT/opencode-config/AGENTS.md"     "$WORKSPACE/AGENTS.md"     2>/dev/null && echo "  ✓ AGENTS.md"     || echo "  ⚠ Não foi possível copiar AGENTS.md"
else
  echo "  ⚠ WORKSPACE_ROOT ($WORKSPACE) não existe — copie manualmente os arquivos de opencode-config/"
fi

# ── 4. Dependências ───────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo ""; echo "📦 Instalando dependências..."
  npm install
fi
echo "✓ Dependências OK"

# ── 5. opencode serve ─────────────────────────────────────────────────
echo ""
echo "🔌 Verificando opencode serve na porta $PORT..."

if curl -sf "http://127.0.0.1:$PORT/global/health" &>/dev/null; then
  echo "✓ opencode serve já está rodando."
else
  echo "  → Iniciando opencode serve em background..."
  OPENCODE_SERVER_PORT=$PORT opencode serve --port "$PORT" > "$ROOT/opencode-serve.log" 2>&1 &
  SERVE_PID=$!
  echo "  → PID: $SERVE_PID (log: opencode-serve.log)"

  # Aguarda até 15s o servidor subir
  echo -n "  → Aguardando health check"
  for i in $(seq 1 15); do
    sleep 1
    echo -n "."
    if curl -sf "http://127.0.0.1:$PORT/global/health" &>/dev/null; then
      echo " ✓"
      break
    fi
    if [ "$i" -eq 15 ]; then
      echo ""
      echo "❌ opencode serve não respondeu em 15s. Verifique opencode-serve.log"
      exit 1
    fi
  done
fi

# ── 6. Dashboard ──────────────────────────────────────────────────────
DASHBOARD="$ROOT/dashboard/index.html"
if [ -f "$DASHBOARD" ]; then
  echo ""
  echo "🌐 Abrindo dashboard..."
  open "$DASHBOARD" 2>/dev/null || xdg-open "$DASHBOARD" 2>/dev/null || true
fi

# ── 7. Orchestrator ───────────────────────────────────────────────────
echo ""
echo "🚀 Iniciando Orchestrator... (Ctrl+C para parar)"
echo ""

# Trap para encerrar o opencode serve junto ao parar o Orchestrator
trap 'echo ""; echo "Encerrando..."; [ -n "$SERVE_PID" ] && kill $SERVE_PID 2>/dev/null; exit 0' INT TERM

npm run dev
