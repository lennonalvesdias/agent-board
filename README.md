# AgentBoard Orchestrator

[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-success?style=flat-square&logo=node.js)](https://nodejs.org/) [![TypeScript 5.4](https://img.shields.io/badge/TypeScript-5.4-2b7a0b?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

**Sistema autônomo de orquestração que monitora um board do Azure DevOps e executa automaticamente os estágios do pipeline de desenvolvimento** — desde a validação de PBI até a aprovação de Pull Request — sem intervenção manual em cada etapa.

---

## Como Funciona

O orquestrador faz polling no Azure DevOps a cada 5 minutos via REST API v7.1. Para cada Product Backlog Item (PBI) elegível, cria uma sessão isolada do OpenCode, injeta contexto, executa o comando correspondente e registra resultados de volta na PBI.

**Fluxo do pipeline:**

```
New → Approved → Commited → InProgress → Review → Done
```

| Estado da PBI | Agent | Comando | Próximo Estado |
|---------------|-------|---------|----------------|
| **New** | Tech Lead | `validate-pbi` | Approved |
| **Approved** | Tech Lead | `generate-specs` | Commited |
| **Commited** | Dev | `assign` + transition | InProgress |
| **InProgress** | Dev | `develop` (por tarefa filha) | Review |
| **Review** | Tech Lead | `analyse-pr` (com iteração) | Done |

A comunicação ocorre via SDK HTTP oficial **`@opencode-ai/sdk`** (não subprocess CLI) e **Microsoft Teams Incoming Webhooks** com Adaptive Cards.

---

## Pré-requisitos

- **Node.js** ≥ 18.0.0
- **OpenCode** instalado e em execução (`opencode serve` na porta 4096 por padrão)
- **Azure DevOps** Personal Access Token (PAT) com:
  - Work Items: Leitura & Escrita
  - Code: Leitura & Escrita
  - Build: Leitura
  - [Gerar PAT](https://dev.azure.com/{org}/_usersSettings/tokens)
- **Git** (para clonar repositórios)
- Arquivo `.env` configurado (ver [Configuração](#configuração))

---

## Início Rápido

### 1. Clonar e Instalar

```bash
git clone <repository-url>
cd agent-board
npm install
```

### 2. Configurar Ambiente

Copie `.env.example` para `.env` e preencha os valores obrigatórios:

```bash
cp .env.example .env
# Editar .env com sua organização do Azure DevOps, projeto e PAT
```

Veja a seção [Configuração](#configuração) para todas as variáveis disponíveis.

### 3. Executar

**Modo desenvolvimento** (com auto-restart em mudanças de arquivo):

```bash
npm run dev
```

**Modo produção** (execução única):

```bash
npm start
```

**Saída compilada** (TypeScript → JavaScript):

```bash
npm run build
npm run start:js
```

**Inicialização completa** (OpenCode + Orchestrator juntos):

- **macOS/Linux:** `bash scripts/start.sh`
- **Windows:** Clique duplo em `INICIAR-WINDOWS.bat` ou `PowerShell scripts/start.ps1`

---

## Configuração

Toda configuração é feita via variáveis de ambiente em `.env`. Use `.env.example` como template.

| Variável | Obrigatória | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `ADO_ORG` | ✅ | — | Nome da organização do Azure DevOps |
| `ADO_PROJECT` | ✅ | — | Nome do projeto do Azure DevOps |
| `ADO_PAT` | ✅ | — | Personal Access Token (permissões de Work Items + Code) |
| `OPENCODE_PORT` | — | `4096` | Porta do serviço OpenCode |
| `OPENCODE_MODEL` | — | `github/copilot` | Modelo padrão de IA para agents |
| `ANTHROPIC_API_KEY` | — | — | Chave API para decisões autônomas de LLM (opcional) |
| `POLLING_INTERVAL_MS` | — | `300000` | Intervalo de polling em milissegundos (300000 = 5 min) |
| `AGENT_TIMEOUT_MS` | — | `1800000` | Tempo máximo de execução do agent em ms (1800000 = 30 min) |
| `LOCK_TTL_MINUTES` | — | `30` | Tempo de vida do lock da PBI em minutos |
| `WORKSPACE_ROOT` | ✅ | — | Diretório raiz para repositórios clonados (ex: `C:\Users\username\repos`) |
| `TEAMS_WEBHOOK_URL` | — | — | URL do Webhook Incoming do Microsoft Teams para notificações |

**Exemplo `.env`:**

```env
ADO_ORG=my-company
ADO_PROJECT=my-project
ADO_PAT=<your-pat-here>
OPENCODE_PORT=4096
WORKSPACE_ROOT=C:\Users\myuser\repos
POLLING_INTERVAL_MS=300000
AGENT_TIMEOUT_MS=1800000
TEAMS_WEBHOOK_URL=https://outlook.webhook.office.com/webhookb2/...
```

---

## Scripts

```bash
npm start         # Executar orchestrator via tsx (desenvolvimento, sem build)
npm run dev       # Modo watch — auto-restart em mudanças de arquivo
npm run build     # Compilar TypeScript → dist/
npm run start:js  # Executar JavaScript compilado a partir de dist/
npx tsc --noEmit  # Type-check apenas (sem arquivos de saída)
```

**Notas:**
- Nenhum framework de testes ou linter está configurado. Type checking via TypeScript é o método principal de verificação.
- Todo código deve passar em `npx tsc --noEmit` antes da deploy.

---

## Estrutura do Projeto

```
src/
├── orchestrator/
│   ├── index.ts           # Loop de polling principal & roteamento de estado (entry point)
│   ├── opencode-runner.ts # Integração do SDK OpenCode
│   └── state-store.ts     # Gerenciamento de lock/estado (arquivo JSON)
├── ado/
│   └── client.ts          # Cliente da API REST v7.1 do Azure DevOps
├── notify/
│   └── teams.ts           # Notificador de Adaptive Cards do Teams
└── config/
    └── index.ts           # Carregador de configuração .env

opencode-config/
├── opencode.json          # Configuração do serviço OpenCode
└── AGENTS.md              # Regras de automação & guias para agents

scripts/
├── start.sh               # Script de inicialização macOS/Linux
└── start.ps1              # Script de inicialização Windows PowerShell

dashboard/
└── index.html             # Dashboard de gerenciamento autossuficiente

dist/                       # Saída compilada (criada por npm run build)
```

**Arquivos principais:**

- **`src/orchestrator/index.ts`** — Loop principal. Faz polling do ADO, roteia PBIs para agents, gerencia transições de estado.
- **`src/ado/client.ts`** — Wrapper da API REST para Work Items, PRs e builds do Azure DevOps.
- **`src/notify/teams.ts`** — Formata e envia notificações de Adaptive Card para o Teams.
- **`opencode-config/AGENTS.md`** — Instrui agents a rodar em modo totalmente autônomo (sem interação com usuário).

---

## Dashboard

Um **`dashboard/index.html`** autossuficiente é incluído para monitoramento em tempo real. Abra diretamente no seu navegador (nenhum servidor necessário).

O dashboard conecta ao OpenCode em `http://127.0.0.1:4096` para exibir:
- Sessões de agent ativas
- Status e logs de execução
- Transições de estado
- Notificações recentes

Isso é útil para observar a atividade do orquestrador sem acesso ao console.

---

## Escalabilidade

Conforme carga e complexidade crescem, o orquestrador pode escalar por três camadas de deploy:

1. **Desenvolvimento Local** — Execute na sua máquina: `npm run dev`
2. **GitHub Actions Self-Hosted** — Configure um runner auto-hospedado com `POLLING_INTERVAL_MS=0` para execução de ciclo único a cada push
3. **Azure Functions Timer Trigger** — Execução serverless em cronograma com state store compartilhado

---

## Licença

MIT

---

## Notas

- Todo código deve passar em modo TypeScript `strict: true`.
- Importações ESM devem incluir extensões `.js` (ex: `import { ADOClient } from "../ado/client.js"`).
- Agents rodam em modo totalmente autônomo e não-interativo. Todas as decisões são tomadas programaticamente baseadas nos critérios de aceite.
- O arquivo `.env` é **nunca** commitado no controle de versão.
