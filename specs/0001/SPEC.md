# AgentBoard — Especificação do Projeto

> Sistema de orquestração autônoma de pipeline de desenvolvimento usando Azure DevOps + OpenCode SDK

---

## Referências

| Recurso | URL |
|---|---|
| **OpenCode — Documentação oficial** | <https://opencode.ai/docs> |
| **Azure DevOps REST API v7.1** | <https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.1> |
| **Azure DevOps — Work Item Tracking** | <https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/?view=azure-devops-rest-7.1> |
| **Azure DevOps — Git API (PRs, Branches)** | <https://learn.microsoft.com/en-us/rest/api/azure/devops/git/?view=azure-devops-rest-7.1> |
| **Azure Pipelines (CI/CD)** | <https://learn.microsoft.com/en-us/azure/devops/pipelines/?view=azure-devops> |
| **Microsoft Teams — Incoming Webhooks** | <https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook> |
| **Microsoft Teams — Adaptive Cards** | <https://learn.microsoft.com/en-us/adaptive-cards/> |
| **OpenCode SDK (`@opencode-ai/sdk`)** | <https://opencode.ai/docs> (seção SDK) |

---

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Contexto e Problema](#2-contexto-e-problema)
3. [Solução](#3-solução)
4. [Pipeline de Estados ADO](#4-pipeline-de-estados-ado)
5. [Agentes](#5-agentes)
6. [Arquitetura Técnica](#6-arquitetura-técnica)
7. [Componentes do Sistema](#7-componentes-do-sistema)
8. [Configuração do OpenCode](#8-configuração-do-opencode)
9. [Decisões Autônomas (Opção A / Opção B)](#9-decisões-autônomas-opção-a--opção-b)
10. [Notificações e Integração com Teams](#10-notificações-e-integração-com-teams)
11. [Dashboard de Gestão](#11-dashboard-de-gestão)
12. [Segurança e Controle](#12-segurança-e-controle)
13. [Estrutura do Projeto](#13-estrutura-do-projeto)
14. [Variáveis de Ambiente](#14-variáveis-de-ambiente)
15. [Scale Path](#15-scale-path)
16. [Premissas e Dependências](#16-premissas-e-dependências)
17. [Sugestões de Evolução](#17-sugestões-de-evolução)
18. [Glossário](#18-glossário)

---

## 1. Visão Geral

O **AgentBoard** é um sistema de orquestração autônoma que monitora um board do Azure DevOps e executa automaticamente os estágios do pipeline de desenvolvimento — da validação de PBI até a aprovação de Pull Request — sem necessidade de intervenção humana a cada etapa.

O sistema reutiliza comandos OpenCode já existentes (`validate-pbi`, `generate-specs`, `generate-tasks`, `develop`, `analyse-pr`) e os orquestra via **SDK oficial do OpenCode** (`@opencode-ai/sdk`), comunicando-se com o servidor OpenCode por HTTP, ao invés de subprocess CLI. Consulte a [documentação oficial do OpenCode](https://opencode.ai/docs) para detalhes da API e configuração.

**Benefício principal:** o time executa o trabalho que hoje é manual e sequencial de forma automática, paralela e auditável, com notificações no Teams e visibilidade total no próprio ADO.

---

## 2. Contexto e Problema

### Fluxo atual (manual)

O time já possui uma stack funcional com o OpenCode integrado ao GitHub Copilot:

| Etapa | Responsável | Ação manual | Comando |
|---|---|---|---|
| Validação DOR | Tech Lead | Abre o PBI, roda o comando no terminal | `validate-pbi <id>` |
| Refinamento técnico | Tech Lead | Preenche observações técnicas + link do architecture-registry, roda o comando | `generate-specs <id>` |
| Geração de tasks | Tech Lead | Revisa spec gerada, roda o comando | `generate-tasks <id>` |
| Desenvolvimento | Desenvolvedor | Pega a task, roda o comando no repositório correto | `develop <task-id>` |
| Code Review | Tech Lead | Revisa o PR manualmente | `analyse-pr <pr-id>` |

**Problemas do fluxo atual:**

- Cada etapa depende de uma pessoa lembrar de rodar o comando manualmente
- Não há visibilidade centralizada do estado de cada PBI no pipeline de agentes
- PBIs ficam parados entre etapas esperando ação humana
- Não existe registro automático de o que o agente fez em cada PBI
- Code review é gargalo: Tech Lead revisa manualmente cada PR
- Escalabilidade zero: 4 devs × N tasks = N comandos manuais por dia

### O que o AgentBoard resolve

- Elimina a necessidade de rodar comandos manualmente
- Monitora o board a cada 5 minutos e age automaticamente
- Registra ações como comentários e tags no próprio PBI no ADO
- Notifica o time via Teams em cada transição de estado, bloqueio e conclusão
- Resolve decisões de implementação autonomamente via LLM com contexto do PBI
- Automatiza code review via `/analyse-pr` com iterações agente-agente
- Mantém log auditável de tudo que os agentes fizeram

---

## 3. Solução

### Conceito central

Um **Orchestrator** (processo Node.js/TypeScript) roda em loop contínuo, consulta o ADO via [REST API v7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.1), e para cada PBI elegível:

1. Cria uma **sessão isolada** no `opencode serve` ([HTTP API](https://opencode.ai/docs))
2. Injeta o contexto completo do PBI na sessão
3. Executa o comando correspondente ao estado atual do PBI
4. Escuta eventos SSE do OpenCode para reagir a permissões e perguntas do agente
5. Registra comentários e tags no PBI ao longo da execução
6. Transiciona o PBI para o próximo estado no ADO ao sucesso
7. Notifica o canal do Teams via [Incoming Webhook + Adaptive Cards](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
8. Deleta a sessão ao fim para não acumular histórico

### Por que HTTP API ao invés de subprocess CLI

A versão inicial (v1) invocava o OpenCode via `subprocess` (`spawn("opencode", ["run", ...])`). Isso foi corrigido na v2 pelos seguintes motivos:

| Problema v1 | Solução v2 |
|---|---|
| `OPENCODE_NONINTERACTIVE` não existe no OpenCode | `"permission": "allow"` no `opencode.json` |
| `AUTO_RESPONDERS` via stdin pipe não existe | `POST /session/:id/permissions/:id` via API |
| Perguntas do agente ficavam sem resposta | SSE listener + LLM decide + `POST /session/:id/message` |
| Sessão global compartilhada | Sessão dedicada por PBI, isolada e descartável |
| Sem acesso ao stream de eventos | `GET /event` SSE em tempo real |

---

## 4. Pipeline de Estados ADO

```
New → Approved → Commited → InProgress → Review → Done
 ↑       ↑          ↑           ↑           ↑       ↑
TechLead TechLead  Dev Agent  Dev Agent  TechLead  Pipelines
Agent    Agent     (atribui)  (por task) Agent     ADO + PM
                                         (analyse  (manual
                                          -pr)     frontend)
```

### Mapeamento estado → agente → comando

| Estado Atual | Agente Responsável | Ação / Comando OpenCode | Estado Seguinte |
|---|---|---|---|
| `New` | Tech Lead Agent | `/validate-pbi` — valida DOR | `Approved` |
| `Approved` | Tech Lead Agent | Preenche observações técnicas + link architecture-registry → `/generate-specs` (que encadeia `/generate-tasks`) | `Commited` |
| `Commited` | Developer Agent | Atribui o PBI a si mesmo | `InProgress` |
| `InProgress` | Developer Agent | `/develop` por task (branch, TDD, implementação, testes, PR) | `Review` |
| `Review` | Tech Lead Agent | `/analyse-pr` — revisão automatizada de PR + iterações com Dev Agent | `Review` (permanece até aprovação) |
| `Review` (PR aprovada) | Pipeline ADO + PM Agent (manual, opcional) | Deploy para HML via esteira ADO; PM valida frontend se necessário | `Done` |
| `Done` | Pipeline ADO | Deploy para produção após aprovações | — |

### Detalhamento de cada transição

#### New → Approved

O PBI foi criado com contexto de negócio (descrição, critérios de aceite, valor). O **Tech Lead Agent** executa `/validate-pbi` para verificar o DOR:

- Critérios de aceite presentes e não-ambíguos
- Valor de negócio descrito
- Stakeholder identificado
- Prioridade definida
- Dependências mapeadas

**Se aprovado:** PBI transiciona para `Approved`. Comentário + tag `dor-validated` adicionados ao PBI. Notificação Teams: ✅ DOR validado.

**Se bloqueado:** PBI permanece em `New`. Comentário detalhando lacunas + tag `dor-blocked`. Notificação Teams: 🔴 DOR reprovado com motivo.

#### Approved → Commited

O **Tech Lead Agent** enriquece o PBI com:

1. **Observações técnicas** — pontos de atenção, restrições, padrões a seguir
2. **Link do architecture-registry** — registro de aplicações e dependências que monta a visão de componentes (frontend, backend, APIM, GitHub repos, Swagger, etc.)

Após o preenchimento, executa `/generate-specs`, que:

1. Lê o PBI enriquecido + architecture-registry referenciado
2. Gera a especificação técnica completa (componentes afetados, endpoints, mudanças de schema, dependências)
3. **Encadeia automaticamente o `/generate-tasks`**: para cada repositório que necessita de mudança, cria uma task filha no ADO especificando o **"como"** completo da mudança — de modo que cada task contenha tudo que o Developer Agent precisa para executar o `/develop`

**Se sucesso:** PBI transiciona para `Commited`. Comentário com resumo da spec + lista de tasks criadas + tag `spec-ready`. Notificação Teams: ✅ Spec gerada, N tasks em M repositórios.

**Se bloqueio:** PBI permanece em `Approved`. Comentário + tag `spec-blocked`. Notificação Teams: 🔴 Spec bloqueada com motivo (ex: architecture-registry não encontrado).

#### Commited → InProgress

O **Developer Agent** é acionado pelo Orchestrator. Atribui o PBI a si mesmo (campo `Assigned To`) e transiciona o estado para `InProgress`.

Notificação Teams: 🔵 PBI atribuído ao Developer Agent, desenvolvimento iniciado.

#### InProgress → Review

O **Developer Agent** executa `/develop` **em cada task filha** do PBI. Para cada task:

1. O comando é executado **dentro do repositório correspondente** à task
2. A task já contém todas as informações necessárias da mudança (geradas no passo anterior)
3. Abre a branch de desenvolvimento no padrão `feature/<task-id>-<slug>`
4. Cria os testes necessários primeiro (TDD)
5. Implementa as mudanças correspondentes
6. Executa uma revisão e roda os testes
7. Se tudo passa, abre uma **Pull Request** linkada ao work item ADO

**Se todas as tasks concluídas com PRs abertas:** PBI transiciona para `Review`. Comentário com links de todos os PRs + tag `pr-opened`. Notificação Teams: ✅ Desenvolvimento concluído, N PRs abertos.

**Se alguma task falhar:** PBI permanece em `InProgress`. Comentário com detalhes do erro na task + tag `dev-blocked`. Notificação Teams: 🔴 Task bloqueada com motivo.

#### Review → Done

O **Tech Lead Agent** executa `/analyse-pr` em cada PR aberta, realizando uma revisão completa:

1. Análise de qualidade do código, aderência à spec e padrões do projeto
2. Deixa comentários inline na PR quando necessário
3. **Iteração agente-agente:** se houver comentários de revisão, o Developer Agent é acionado para aplicar correções e atualizar a PR. O Tech Lead Agent re-executa `/analyse-pr` após as correções.
4. O ciclo de revisão-correção repete até que a PR esteja aprovada

**Após aprovação do PR:**

1. A esteira de deploy do Azure DevOps ([Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/?view=azure-devops)) é acionada para o ambiente de **HML**
2. O **PM Agent** realiza validação **manual somente em casos que exigem validação de experiência** (ex: mudanças de frontend/UX). Esta é a única ação manual obrigatória no fluxo.
3. Após validação HML (automática ou manual), a esteira segue para **produção**
4. PBI transiciona para `Done`. Tag `done`. Notificação Teams: ✅ PBI concluído e em produção.

### Regras de elegibilidade

Um PBI é elegível para processamento quando:

- Está nos estados `New`, `Approved`, `Commited`, `InProgress` ou `Review`
- Seu tipo é `Product Backlog Item`
- Não possui lock ativo no `StateStore` (não está sendo processado no ciclo atual)
- O lock do ciclo anterior expirou (TTL padrão: 30 minutos)

---

## 5. Agentes

### 5.1 Tech Lead Agent (`validate-pbi`, `generate-specs`, `analyse-pr`)

**Objetivo:** Garantir a qualidade do pipeline de ponta a ponta — desde a validação de requisitos até a aprovação de código.

O Tech Lead Agent é o agente mais versátil do sistema. Atua em três estados distintos do pipeline:

#### 5.1.1 Estado `New` — Validação DOR (`/validate-pbi`)

**Critérios verificados:**

- Critérios de aceite presentes e não-ambíguos
- Valor de negócio descrito
- Stakeholder identificado
- Prioridade definida
- Dependências mapeadas

**Ações no ADO ao concluir:**
- Comentário com resultado da validação
- Tag `dor-validated` (sucesso) ou `dor-blocked` (falha)

> O Tech Lead Agent neste modo só lê — nunca modifica arquivos do repositório.

**Output esperado:**

```
SUMMARY: DOR validado — 4 critérios de aceite completos. PBI pronto para refinamento.
```

ou em caso de bloqueio:

```
SUMMARY: BLOQUEIO — critérios de aceite ausentes. Campo "Acceptance Criteria" vazio.
```

#### 5.1.2 Estado `Approved` — Especificação técnica (`/generate-specs` + `/generate-tasks`)

**Responsabilidades:**

1. Preencher observações técnicas no PBI (pontos de atenção, restrições, padrões)
2. Adicionar o link de referência do **architecture-registry** (registro de aplicações e dependências que monta a visão de componentes: frontend, backend, APIM, repos GitHub, Swagger, etc.)
3. Executar `/generate-specs` que:
   - Lê o PBI enriquecido + architecture-registry referenciado
   - Identifica quais repositórios e workspaces são impactados
   - Gera a spec técnica com: componentes afetados, endpoints, mudanças de schema, dependências
4. O próprio `/generate-specs` encadeia o `/generate-tasks`:
   - Cria uma **task por repositório** no ADO (child work items)
   - Cada task especifica o **"como" completo** da mudança: arquivos a modificar, lógica de implementação, testes esperados, critérios de conclusão
   - O objetivo é que a task tenha **tudo o que precisa** para o Developer Agent executar o `/develop` sem ambiguidades

**Ações no ADO ao concluir:**
- Comentário com resumo da spec + lista de tasks criadas
- Tag `spec-ready` (sucesso) ou `spec-blocked` (falha)

**Output esperado:**

```
SUMMARY: Spec gerada — 3 tasks criadas em 2 repositórios (api-service, frontend-web).
```

#### 5.1.3 Estado `Review` — Revisão de PR (`/analyse-pr`)

**Responsabilidades:**

1. Executar `/analyse-pr` em cada PR aberta do PBI
2. Analisar qualidade do código, aderência à spec técnica e padrões do projeto
3. Deixar comentários inline na PR
4. Se necessário, solicitar correções ao Developer Agent (iteração agente-agente)
5. Aprovar a PR quando os critérios estiverem satisfeitos

**Ações no ADO ao concluir:**
- Comentário na PR com resultado da revisão
- Comentário no PBI com status da revisão
- Tag `pr-approved` (sucesso) ou `pr-changes-requested` (correções necessárias)

**Output esperado:**

```
SUMMARY: PR #847 aprovada — código aderente à spec, 2 comentários menores resolvidos.
```

ou com iteração:

```
SUMMARY: PR #847 — 3 comentários de revisão postados, aguardando correções do Dev Agent.
```

**Permissões OpenCode (Tech Lead Agent):**

```json
{
  "bash": { "*": "allow", "git *": "allow", "grep *": "allow" },
  "edit": "allow",
  "read": "allow",
  "webfetch": "allow"
}
```

---

### 5.2 Developer Agent (`develop`)

**Objetivo:** Implementar tasks de desenvolvimento de ponta a ponta, seguindo TDD.

**Responsabilidades:**

1. No estado `Commited`: atribuir o PBI e transicionar para `InProgress`
2. No estado `InProgress`: executar `/develop` em cada task filha do PBI
3. O comando `/develop` é executado **dentro do repositório correspondente à task**
4. A task já contém todas as informações necessárias da mudança (geradas pelo Tech Lead Agent)

**Fluxo do `/develop` por task:**

1. Criar branch no padrão `feature/<task-id>-<slug>`
2. Ler a spec técnica da task para entender o escopo exato
3. Criar os testes necessários primeiro (**TDD** — testes antes da implementação)
4. Implementar as mudanças nos arquivos corretos
5. Fazer revisão do próprio código e executar os testes
6. Se tudo estiver com sucesso, abrir **Pull Request** linkado ao work item ADO
7. Se o Tech Lead Agent solicitar correções durante o Review, aplicá-las e atualizar a PR

**Ações no ADO ao concluir:**
- Comentário com link da PR e resumo das mudanças por task
- Tag `pr-opened` por task concluída, ou `dev-blocked` em caso de falha

**Permissões OpenCode (Dev Agent):**

```json
{
  "permission": "allow"
}
```

> O Dev Agent tem acesso total pois precisa criar branches, fazer commits e abrir PRs.

**Output esperado:**

```
SUMMARY: PR #847 criado — branch feature/1265-carrinho-live, 3 arquivos modificados, 12 testes adicionados.
```

---

### 5.3 PM Agent (validação manual de frontend)

**Objetivo:** Validar a experiência do usuário em mudanças de frontend.

O PM Agent **não é automatizado** na v1 — é uma ação manual que ocorre somente quando o PBI envolve mudanças de interface/UX. O Orchestrator identifica PBIs com tag `needs-ux-review` (adicionada pelo Tech Lead Agent na spec) e envia notificação ao Teams solicitando validação manual do PM.

**Quando é acionado:**
- Durante o estado `Review`, após aprovação da PR e deploy em HML
- Somente para PBIs com mudanças de frontend (tag `needs-ux-review`)

**Ação:**
- PM valida a experiência no ambiente HML
- Aprova ou reprova com comentário no PBI
- Se aprovado, a esteira segue para produção

> **Evolução futura:** automatizar via testes visuais (Playwright screenshots + LLM comparison). Ver [Seção 17 — Sugestões de Evolução](#17-sugestões-de-evolução).

---

## 6. Arquitetura Técnica

### Visão geral

```
┌──────────────────────────────────────────────────────────────────────┐
│  Máquina Local / Self-hosted runner                                  │
│                                                                      │
│  ┌────────────────────┐         ┌──────────────────────────────┐    │
│  │  AgentBoard         │         │  opencode serve              │    │
│  │  Orchestrator       │◄──────► │  HTTP API (porta 4096)       │    │
│  │  (Node.js/TS)       │  SDK    │  docs: opencode.ai/docs      │    │
│  │                     │         │                              │    │
│  │  Loop: 5 min        │         │  Sessões isoladas por PBI    │    │
│  │  polling ADO        │         │  Executa comandos            │    │
│  └────────┬────────────┘         │  GitHub Copilot models       │    │
│           │                      └──────────────────────────────┘    │
│           │ REST API v7.1                 SSE stream                 │
│           ▼                               ▲                          │
│  ┌──────────────────┐           ┌─────────┴──────────┐              │
│  │  Azure DevOps    │           │  Event Handler      │              │
│  │                  │           │  - permission.req   │              │
│  │  Work Items      │           │  - agent question   │              │
│  │  Transitions     │           │  - LLM resolver     │              │
│  │  Comments + Tags │           │  - review iteration │              │
│  │  Child Tasks     │           └────────────────────┘              │
│  │  Pull Requests   │                                                │
│  └────────┬─────────┘                                                │
│           │                                                          │
│           │ Azure Pipelines (CI/CD)                                  │
│           │ Deploy HML → Produção                                    │
│           │                                                          │
└───────────┼──────────────────────────────────────────────────────────┘
            │
            │ Webhook (Incoming Webhook + Adaptive Cards)
            ▼
┌──────────────────┐
│  Microsoft Teams │
│  Notificações    │
│  por transição   │
└──────────────────┘
```

### Fluxo de execução por PBI

```
ADO polling
    │
    ▼ PBI em estado tratável + sem lock
StateStore.lock(pbi:estado, ttl=30min)
    │
    ▼
opencode serve: POST /session
    → sessão isolada criada
    │
    ▼
POST /session/:id/message (noReply: true)
    → contexto do PBI injetado (sem resposta do agente)
    │
    ▼
POST /session/:id/command
    → comando executado (aguarda resposta completa)
    │
    ▼ (em paralelo)
GET /event (SSE)
    ├── permission.updated → POST /session/:id/permissions/:id { allow }
    └── message.completed (pergunta?) → LLM decide → POST /session/:id/message
    │
    ▼ Resultado
    ├── Sucesso → ADO transition + ADO comment + ADO tag + Teams notify
    └── Falha   → ADO comment + ADO tag + Teams notify + StateStore.unlock()
    │
    ▼
DELETE /session/:id
```

### Fluxo de iteração Review (agente-agente)

```
Tech Lead Agent: /analyse-pr
    │
    ▼
PR tem problemas?
    ├── Não → Approve PR → ADO tag pr-approved → Teams ✅
    │
    └── Sim → Post review comments na PR
              │
              ▼
         Dev Agent: aplica correções + push
              │
              ▼
         Tech Lead Agent: /analyse-pr (re-review)
              │
              ▼
         (repete até aprovação ou max 3 iterações)
              │
              └── Max iterações → ADO tag pr-needs-human → Teams 🟡 escalação
```

---

## 7. Componentes do Sistema

### 7.1 Orchestrator (`src/orchestrator/index.ts`)

Loop principal. Responsabilidades:

- Polling ADO a cada `POLLING_INTERVAL_MS` (padrão: 5 min)
- Verificar saúde do `opencode serve` antes de cada ciclo
- Rotear PBIs para o agente correto baseado no estado (`New`, `Approved`, `Commited`, `InProgress`, `Review`)
- Processar tasks filhas para PBIs em estado `InProgress`
- Orquestrar iterações de review entre Tech Lead Agent e Developer Agent
- Gerenciar locks via `StateStore`
- Registrar comentários e tags no PBI a cada ação

### 7.2 OpenCode Runner (`src/orchestrator/opencode-runner.ts`)

Camada de integração com o [OpenCode via SDK oficial](https://opencode.ai/docs). Responsabilidades:

- Criar e deletar sessões
- Injetar contexto do work item (`noReply: true`)
- Executar comandos (`validate-pbi`, `generate-specs`, `generate-tasks`, `develop`, `analyse-pr`) e aguardar resposta
- Escutar SSE para eventos de permissão e perguntas do agente
- Chamar o LLM resolver quando o agente fizer uma pergunta
- Respeitar timeout configurável por execução

### 7.3 State Store (`src/orchestrator/state-store.ts`)

Controle de locks por arquivo JSON local (`.agentboard-state.json`). Responsabilidades:

- Impedir processamento paralelo do mesmo PBI
- Expirar locks automaticamente após TTL
- Persistir estado entre reinicializações do Orchestrator
- Rastrear iterações de review (contagem de ciclos revisão-correção)

> Interface agnóstica: troque por Azure Table Storage sem mudar o Orchestrator.

### 7.4 ADO Client (`src/ado/client.ts`)

Wrapper para a [ADO REST API v7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.1). Operações:

- `getWorkItems()` — busca PBIs elegíveis via [WIQL](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql?view=azure-devops-rest-7.1)
- `getChildTasks()` — lista tasks filhas de um PBI
- `transition()` — muda o estado de um work item
- `updateTask()` — atualiza estado e comentário de uma task
- `addComment()` — posta comentário no PBI (bloqueio, log, etc.)
- `addTag()` — adiciona tag ao PBI (ex: `dor-validated`, `spec-ready`, `pr-opened`)
- `assignWorkItem()` — atribui o PBI a um agente (campo `Assigned To`)
- `getPullRequests()` — lista PRs ligadas a um work item via [Git API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/?view=azure-devops-rest-7.1)

### 7.5 Teams Notifier (`src/notify/teams.ts`)

Envio de [Adaptive Cards](https://learn.microsoft.com/en-us/adaptive-cards/) via [Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook). Eventos notificados:

- Agente iniciado (com indicador visual por tipo de agente)
- DOR validado ou bloqueado
- Spec gerada com lista de tasks
- PBI atribuído ao Developer Agent
- Task implementada com link da PR
- PR aprovada ou com correções necessárias
- Escalação para revisão humana (max iterações de review atingidas)
- PBI concluído e em produção
- PBI bloqueado (qualquer estado)
- Erro inesperado

### 7.6 Config (`src/config/index.ts`)

Centraliza leitura do `.env` com validação de variáveis obrigatórias na inicialização.

---

## 8. Configuração do OpenCode

> Referência completa: <https://opencode.ai/docs>

### `opencode.json` (colocar na raiz de cada workspace/repo)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow",
  "agent": {
    "validate-pbi": {
      "description": "Valida PBI contra DOR. Retorna SUMMARY: com resultado.",
      "mode": "primary",
      "permission": { "edit": "deny", "bash": { "*": "allow" }, "webfetch": "allow" },
      "steps": 20
    },
    "generate-specs": {
      "description": "Gera spec técnica a partir do PBI + architecture-registry. Encadeia generate-tasks.",
      "mode": "primary",
      "permission": { "edit": "allow", "bash": { "*": "allow" }, "read": "allow" },
      "steps": 40
    },
    "generate-tasks": {
      "description": "Cria tasks filhas no ADO, uma por repositório impactado. Retorna SUMMARY: com N tasks.",
      "mode": "primary",
      "permission": { "edit": "allow", "bash": { "*": "allow" }, "read": "allow" },
      "steps": 30
    },
    "develop": {
      "description": "Implementa task: branch, TDD, código, testes, PR. Retorna SUMMARY: com link do PR.",
      "mode": "primary",
      "permission": "allow",
      "steps": 80
    },
    "analyse-pr": {
      "description": "Revisa PR: qualidade, aderência à spec, padrões. Retorna SUMMARY: com resultado.",
      "mode": "primary",
      "permission": { "edit": "deny", "bash": { "*": "allow", "git *": "allow" }, "read": "allow" },
      "steps": 30
    }
  }
}
```

**Por que `"permission": "allow"` globalmente?**

O OpenCode pede confirmação antes de executar ferramentas (`bash`, `edit`, etc.). No modo automatizado, não existe usuário para confirmar — o processo travaria. A configuração `"permission": "allow"` elimina todos os prompts. Permissões granulares por agente sobrescrevem o default onde necessário.

### `AGENTS.md` (colocar na raiz de cada workspace/repo)

Define o comportamento dos agentes em modo automatizado:

- **Nunca perguntar ao usuário** (não existe usuário na sessão)
- Em caso de ambiguidade, escolher a opção mais simples que atenda os critérios de aceite
- Sempre terminar com `SUMMARY: <resultado>` para o Orchestrator capturar
- Em caso de bloqueio real, terminar com `SUMMARY: BLOQUEIO — <motivo>`

### Comandos OpenCode (`.opencode/commands/` em cada repositório)

Os comandos já existem e não precisam ser reescritos. O Orchestrator os invoca via `session.command()`. Estrutura recomendada:

**`.opencode/commands/validate-pbi.md`**
```markdown
---
description: Valida PBI contra o Definition of Readiness
agent: validate-pbi
---
Valide o PBI #$ARGUMENTS contra o DOR do projeto.
Verifique critérios de aceite, valor de negócio, stakeholder e prioridade.
Retorne SUMMARY: com resultado.
```

**`.opencode/commands/generate-specs.md`**
```markdown
---
description: Gera spec técnica a partir do PBI + architecture-registry
agent: generate-specs
---
Para o PBI #$ARGUMENTS, leia o architecture-registry referenciado no PBI
e gere especificação técnica completa.
Após gerar a spec, execute /generate-tasks para criar as tasks filhas.
Retorne SUMMARY: com número de tasks criadas e repositórios impactados.
```

**`.opencode/commands/generate-tasks.md`**
```markdown
---
description: Cria tasks filhas no ADO por repositório impactado
agent: generate-tasks
---
Para o PBI #$ARGUMENTS, leia a spec técnica gerada e crie uma task filha
no ADO para cada repositório que necessita de mudança.
Cada task deve conter o "como" completo: arquivos, lógica, testes esperados.
Retorne SUMMARY: com número de tasks criadas.
```

**`.opencode/commands/develop.md`**
```markdown
---
description: Implementa uma task de desenvolvimento com TDD
agent: develop
---
Implemente a task #$ARGUMENTS:
1. Crie branch feature/<id>-<slug>
2. Crie os testes primeiro (TDD)
3. Implemente as mudanças conforme a spec da task
4. Execute os testes e garanta que passem
5. Abra PR linkado ao work item
Retorne SUMMARY: com link do PR criado.
```

**`.opencode/commands/analyse-pr.md`**
```markdown
---
description: Revisa Pull Request quanto a qualidade e aderência à spec
agent: analyse-pr
---
Revise a PR #$ARGUMENTS:
1. Verifique aderência à spec técnica do PBI
2. Verifique qualidade do código e padrões do projeto
3. Verifique cobertura de testes
4. Deixe comentários inline para problemas encontrados
Retorne SUMMARY: com resultado (aprovada ou correções necessárias).
```

---

## 9. Decisões Autônomas (Opção A / Opção B)

Um dos desafios centrais da automação é quando o agente encontra uma decisão de implementação e precisa escolher entre abordagens. Sem um humano no loop, o processo travaria.

### Como funciona

O **SSE Listener** do `OpenCodeRunner` monitora o stream de eventos do OpenCode em paralelo com a execução do comando. Quando detecta uma mensagem do agente que parece uma pergunta (via pattern matching), aciona o **LLM Resolver**:

```
[Agente pergunta] "Devo usar JWT ou session cookies para o token?"
         │
         ▼
isAgentQuestion(text) → true
         │
         ▼
resolveAgentQuestion(pergunta, contexto_do_pbi)
         │
         ├── Com ANTHROPIC_API_KEY: chama claude-haiku com contexto do PBI
         │   → "Com base nos critérios de aceite do PBI #1298 (autenticação mobile),
         │      use JWT — é a abordagem mais adequada para clientes mobile stateless."
         │
         └── Sem API key: fallback genérico
             → "Escolha a opção mais simples que atenda os critérios de aceite..."
         │
         ▼
POST /session/:id/message { text: resposta_decidida }
         │
         ▼
[Agente continua a implementação]
```

### Padrões detectados como pergunta

- `opção A ou B` / `abordagem 1 ou 2`
- `qual você prefere` / `como você gostaria`
- `should I use` / `which approach`
- Mensagem terminando com `?`

### Instrução proativa no `AGENTS.md`

Além do mecanismo reativo, o `AGENTS.md` instrui os agentes a **não perguntar** desde o início:

> *"Se precisar tomar uma decisão de implementação (opção A vs B), escolha a mais simples que satisfaça os critérios de aceite. Prefira padrões já existentes no projeto. Não pergunte — implemente."*

A combinação das duas estratégias (instrução proativa + resolver reativo) garante que o processo não trave mesmo nos casos mais imprevistos.

---

## 10. Notificações e Integração com Teams

As notificações são enviadas via **[Microsoft Teams Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)** usando **[Adaptive Cards](https://learn.microsoft.com/en-us/adaptive-cards/)**.

### Eventos notificados por estado

| Estado | Evento | Card | Cor |
|---|---|---|---|
| `New` → `Approved` | DOR validado | ✅ Link ADO, critérios verificados | Verde |
| `New` (bloqueio) | DOR reprovado | 🔴 Motivo detalhado, link ADO | Vermelho |
| `Approved` → `Commited` | Spec gerada + tasks criadas | ✅ N tasks em M repos, link ADO | Verde |
| `Approved` (bloqueio) | Spec bloqueada | 🔴 Motivo (ex: registry ausente), link ADO | Vermelho |
| `Commited` → `InProgress` | PBI atribuído ao Dev Agent | 🔵 Desenvolvimento iniciado | Azul |
| `InProgress` → `Review` | PRs abertas | ✅ Links de todos os PRs criados | Verde |
| `InProgress` (bloqueio) | Task com falha | 🔴 Task específica + motivo | Vermelho |
| `Review` | PR revisada — aprovada | ✅ PR aprovada, deploy HML iniciado | Verde |
| `Review` | PR revisada — correções | 🟡 Comentários postados, Dev Agent corrigindo | Amarelo |
| `Review` | Escalação — max iterações | 🟡 Revisão humana necessária | Amarelo |
| `Review` | Validação UX necessária | 🟣 PM precisa validar frontend em HML | Roxo |
| `Review` → `Done` | PBI concluído | ✅ Em produção | Verde |
| Qualquer | Erro inesperado | 🔥 Detalhes do erro | Vermelho |

### Integração de Teams recomendada por canal

| Canal Teams | Notificações | Propósito |
|---|---|---|
| `#agentboard-pipeline` | Todas as transições de estado | Visibilidade geral do pipeline |
| `#agentboard-blockers` | Apenas bloqueios e escalações | Ação rápida em impedimentos |
| `#code-reviews` | PR aberta, revisão, aprovação | Acompanhamento de PRs |

> **Configuração por canal:** usar variáveis `TEAMS_WEBHOOK_PIPELINE`, `TEAMS_WEBHOOK_BLOCKERS`, `TEAMS_WEBHOOK_REVIEWS`. Se apenas `TEAMS_WEBHOOK_URL` estiver definido, todas as notificações vão para o mesmo canal.

### Como configurar

1. No Teams: canal → `...` → Conectores → Incoming Webhook → Criar
2. Copiar a URL gerada
3. Definir `TEAMS_WEBHOOK_URL=<url>` no `.env` (ou as variáveis por canal)
4. Se vazio, notificações são desabilitadas silenciosamente

### Ações interativas nos cards (evolução sugerida)

Os Adaptive Cards suportam [Action.Submit](https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/input-validation) para interações diretas. Possibilidades:

- **Botão "Aprovar validação UX"** no card de `needs-ux-review` → PM aprova direto pelo Teams
- **Botão "Re-executar"** no card de bloqueio → dispara reprocessamento do PBI
- **Botão "Ver logs"** → abre modal com detalhes da sessão OpenCode

> Requer um endpoint HTTP no Orchestrator para receber callbacks dos botões. Ver [Seção 17](#17-sugestões-de-evolução).

---

## 11. Dashboard de Gestão

Um arquivo HTML standalone (`dashboard/index.html`) que pode ser aberto diretamente no browser. **Não requer servidor** — conecta diretamente ao `opencode serve` local via `http://127.0.0.1:4096`.

### Funcionalidades

- **Status do `opencode serve`** em tempo real (health check + versão + sessões abertas)
- **Kanban visual** com todos os PBIs por estado, indicadores visuais de status (em execução, bloqueado, concluído)
- **Sessões OpenCode ativas** listadas com ID e título
- **Log de eventos** em tempo real
- **Countdown** para o próximo ciclo de polling + botão "Atualizar Agora"
- **Modal de detalhes** ao clicar em qualquer PBI

### Para integração real

O dashboard atualmente usa dados demonstrativos para o kanban e log. Para conectar ao estado real:

1. Adicionar uma rota `GET /api/state` ao Orchestrator que sirva o conteúdo do `.agentboard-state.json`
2. Servir a pasta `dashboard/` com qualquer servidor estático (`npx serve dashboard/`)
3. O dashboard já faz fetch real do `opencode serve` para status, versão e sessões

---

## 12. Segurança e Controle

### Lock System

O `StateStore` usa um arquivo JSON local (`.agentboard-state.json`) com TTL por entrada. Garante que:

- Um PBI não seja processado em paralelo por dois ciclos sobrepostos
- Locks travados (ex: processo morreu) expirem automaticamente após 30 minutos
- O estado persiste entre reinicializações do Orchestrator

Para forçar o reprocessamento de um PBI específico:

```bash
# Remove lock de PBI 1234 no estado "Aprovado"
node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('.agentboard-state.json','utf-8'));
delete s['1234:Aprovado'];
fs.writeFileSync('.agentboard-state.json', JSON.stringify(s, null, 2));
"
```

### Permissões ADO (PAT)

O Personal Access Token deve ter somente as permissões mínimas necessárias:

- **Work Items**: Read & Write (transições, comentários, tags, tasks)
- **Code**: Read & Write (clone, branches, commits, PRs)
- **Build**: Read (monitorar status de pipelines)

### Rastreabilidade

Cada ação do agente é registrada no próprio PBI no ADO em dois formatos:

**Comentários** — detalhes da execução:
- Nome do agente responsável
- Comando executado
- Resultado (sucesso/bloqueio)
- Resumo do output
- Timestamp
- Links para artefatos gerados (spec, PRs)

**Tags** — status rápido e filtrável:
- `dor-validated` / `dor-blocked` — resultado da validação DOR
- `spec-ready` / `spec-blocked` — resultado da geração de spec
- `pr-opened` — PR aberta pelo Dev Agent
- `pr-approved` / `pr-changes-requested` — resultado da revisão
- `pr-needs-human` — escalação para revisão humana
- `needs-ux-review` — PM precisa validar frontend
- `done` — PBI concluído

Isso garante auditoria completa sem ferramentas externas e permite queries WIQL por tags para dashboards e relatórios.

---

## 13. Estrutura do Projeto

```
agentboard/
│
├── src/
│   ├── orchestrator/
│   │   ├── index.ts              # Loop principal + roteamento por estado
│   │   ├── opencode-runner.ts    # Integração com opencode serve via SDK
│   │   └── state-store.ts        # Lock system por arquivo JSON
│   │
│   ├── ado/
│   │   └── client.ts             # ADO REST API v7.1 (WIQL, transições, comentários, tags, PRs)
│   │
│   ├── notify/
│   │   └── teams.ts              # Adaptive Cards via Teams Webhook
│   │
│   └── config/
│       └── index.ts              # Leitura de .env com validação
│
├── opencode-config/              # Arquivos a copiar para cada workspace
│   ├── opencode.json             # permission: allow + definição de agentes
│   └── AGENTS.md                 # Regras de modo não-interativo
│
├── dashboard/
│   └── index.html                # Dashboard standalone (abre direto no browser)
│
├── scripts/
│   ├── start.sh                  # Startup Mac/Linux (inicia opencode serve + orchestrator)
│   └── start.ps1                 # Startup Windows PowerShell
│
├── specs/
│   └── 0001/
│       └── SPEC.md               # Esta especificação
│
├── INICIAR-WINDOWS.bat           # Duplo-clique para iniciar no Windows
├── AGENTS.md                     # Regras globais para agentes AI neste repo
├── .env.example                  # Template de variáveis
├── package.json
├── tsconfig.json
└── README.md
```

---

## 14. Variáveis de Ambiente

| Variável | Obrigatória | Descrição | Padrão |
|---|---|---|---|
| `ADO_ORG` | ✓ | Organização Azure DevOps | — |
| `ADO_PROJECT` | ✓ | Projeto Azure DevOps | — |
| `ADO_PAT` | ✓ | Personal Access Token | — |
| `OPENCODE_PORT` | — | Porta do `opencode serve` | `4096` |
| `OPENCODE_MODEL` | — | Modelo padrão (sobrescrito por agente) | `github/copilot` |
| `ANTHROPIC_API_KEY` | — | Para resolver perguntas do agente via LLM | fallback sem LLM |
| `POLLING_INTERVAL_MS` | — | Intervalo de polling | `300000` (5 min) |
| `AGENT_TIMEOUT_MS` | — | Timeout máximo por execução de agente | `1800000` (30 min) |
| `LOCK_TTL_MINUTES` | — | TTL dos locks de PBI | `30` |
| `WORKSPACE_ROOT` | — | Raiz dos repositórios clonados | `~/repos` |
| `TEAMS_WEBHOOK_URL` | — | Webhook Teams geral (vazio = desabilitado) | — |
| `TEAMS_WEBHOOK_PIPELINE` | — | Webhook para transições de estado | fallback: `TEAMS_WEBHOOK_URL` |
| `TEAMS_WEBHOOK_BLOCKERS` | — | Webhook para bloqueios e escalações | fallback: `TEAMS_WEBHOOK_URL` |
| `TEAMS_WEBHOOK_REVIEWS` | — | Webhook para acompanhamento de PRs | fallback: `TEAMS_WEBHOOK_URL` |
| `MAX_REVIEW_ITERATIONS` | — | Máximo de ciclos revisão-correção antes de escalar | `3` |

---

## 15. Scale Path

O sistema foi projetado para escalar progressivamente sem reescritas:

### Nível 1 — Local (atual)

Execução via `npm run dev` na máquina do Tech Lead ou em uma máquina dedicada.

```bash
bash scripts/start.sh
```

**Adequado para:** times pequenos, fase de validação, ambiente de desenvolvimento.

### Nível 2 — GitHub Actions self-hosted runner

Registrar a máquina como runner do GitHub Actions e criar um workflow agendado:

```yaml
on:
  schedule:
    - cron: '*/5 * * * *'

jobs:
  orchestrate:
    runs-on: self-hosted
    steps:
      - run: npm run start
    env:
      POLLING_INTERVAL_MS: 0  # executa um ciclo e encerra
```

**Zero mudanças de código.** O Orchestrator com `POLLING_INTERVAL_MS=0` executa um único ciclo e encerra — o GitHub Actions cuida do agendamento.

**Adequado para:** automação contínua sem servidor dedicado.

### Nível 3 — Azure Functions (Timer Trigger)

Substituir o `setInterval` em `src/orchestrator/index.ts` por um Timer Trigger:

```typescript
// Antes (local):
setInterval(runCycle, config.pollingIntervalMs);

// Depois (Azure Functions):
export default async function (context: Context, timer: Timer) {
  await runCycle();
}
```

O `opencode serve` seria movido para um container no Azure (ACI ou AKS).

**Adequado para:** produção em escala, alta disponibilidade, múltiplos projetos.

---

## 16. Premissas e Dependências

### Dependências de software

| Dependência | Versão mínima | Uso | Docs |
|---|---|---|---|
| Node.js | 18.0.0 | Runtime do Orchestrator | — |
| OpenCode | latest | `opencode serve` — executa os agentes | <https://opencode.ai/docs> |
| Git | qualquer | Dev Agent: clone, commit, push | — |
| `@opencode-ai/sdk` | latest | Comunicação com opencode serve via HTTP | <https://opencode.ai/docs> |
| Azure DevOps | REST API v7.1 | Work items, PRs, pipelines | <https://learn.microsoft.com/en-us/rest/api/azure/devops/> |
| Microsoft Teams | Incoming Webhooks | Notificações Adaptive Cards | <https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook> |

### Premissas do ambiente

- `opencode serve` rodando na porta configurada **antes** do Orchestrator iniciar (os scripts de start garantem isso)
- `opencode.json` com `"permission": "allow"` presente na raiz de cada workspace onde os agentes operam
- `AGENTS.md` com instruções de modo não-interativo presente na raiz de cada workspace
- Os comandos `validate-pbi`, `generate-specs`, `generate-tasks`, `develop` e `analyse-pr` existem em `.opencode/commands/` de cada repositório
- O **architecture-registry** (registro de aplicações e dependências) existe e está acessível via link referenciado no PBI
- PAT do ADO com permissões de leitura/escrita em Work Items, Code e Pull Requests
- Esteiras de CI/CD configuradas no Azure Pipelines para deploy em HML e produção

### Premissas sobre os comandos existentes

Os comandos não precisam ser modificados, mas devem:

- Terminar com `SUMMARY: <resultado>` na última linha do output para que o Orchestrator capture o resumo
- Terminar com `SUMMARY: BLOQUEIO — <motivo>` quando houver um impeditivo real
- Opcionalmente emitir `ARTIFACT: <path>` para artefatos gerados (spec.md, etc.)
- O `/generate-specs` deve encadear `/generate-tasks` automaticamente ao concluir

---

## 17. Sugestões de Evolução

Áreas onde o sistema pode evoluir para reduzir ainda mais intervenção manual e aumentar a confiabilidade:

### 17.1 Automação da validação de UX (PM Agent)

**Problema atual:** A validação de frontend/UX pelo PM é manual — requer que alguém acesse o HML e valide visualmente.

**Evolução sugerida:**
- Integrar testes visuais automatizados com **Playwright** (screenshots antes/depois)
- Usar LLM com visão (GPT-4o, Claude) para comparar screenshots com os critérios de aceite do PBI
- Criar um comando `/validate-ux` que capture screenshots do HML e gere relatório visual
- PM recebe o relatório no Teams e aprova/reprova com um botão no Adaptive Card

**Impacto:** Elimina a última ação manual obrigatória do pipeline para PBIs de frontend.

### 17.2 Ações interativas no Teams (botões nos cards)

**Problema atual:** As notificações são somente informativas — qualquer ação requer ir ao ADO.

**Evolução sugerida:**
- Adicionar `Action.Submit` nos Adaptive Cards para ações diretas:
  - "Aprovar UX" / "Reprovar UX" no card de validação de frontend
  - "Re-executar" no card de bloqueio
  - "Escalar para humano" no card de review com problemas
- Criar endpoint `POST /api/actions` no Orchestrator para receber callbacks
- Usar [Azure Bot Framework](https://learn.microsoft.com/en-us/azure/bot-service/) se necessário para interações mais ricas

**Impacto:** Time resolve situações direto pelo Teams sem trocar de contexto.

### 17.3 Deploy automatizado pós-aprovação

**Problema atual:** Após aprovação da PR e validação HML, o deploy para produção depende de configuração manual do pipeline ou trigger manual.

**Evolução sugerida:**
- Implementar trigger automático de pipeline de produção via [Azure Pipelines REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/)
- Adicionar gate de aprovação no pipeline com notificação Teams
- Orchestrator monitora status do pipeline e transiciona PBI para `Done` ao concluir

**Impacto:** Pipeline end-to-end totalmente automatizado.

### 17.4 Métricas e observabilidade

**Problema atual:** Sem métricas sobre tempo de ciclo, taxa de bloqueio, ou performance dos agentes.

**Evolução sugerida:**
- Emitir métricas no formato OpenTelemetry ou enviar para Application Insights
- Dashboards de: tempo médio por estado, taxa de sucesso/bloqueio, iterações de review
- Alertas quando um PBI está preso em um estado acima do SLA

**Impacto:** Visibilidade para otimizar o pipeline e identificar gargalos.

### 17.5 Rollback automatizado

**Problema atual:** Se um deploy em produção causar problemas, o rollback é manual.

**Evolução sugerida:**
- Monitorar health checks pós-deploy via Application Insights ou Azure Monitor
- Se degradação detectada, acionar rollback automático via pipeline
- Notificar time no Teams com detalhes do rollback

**Impacto:** Reduz MTTR (Mean Time to Recovery) significativamente.

### 17.6 Paralelismo de tasks

**Problema atual:** O Developer Agent processa tasks sequencialmente dentro de um PBI.

**Evolução sugerida:**
- Processar tasks de repositórios diferentes em paralelo (sessões OpenCode independentes)
- Limitar concorrência para não sobrecarregar o `opencode serve`
- Usar semáforos no StateStore para controle de paralelismo

**Impacto:** PBIs com múltiplos repositórios concluem significativamente mais rápido.

---

## 18. Glossário

| Termo | Definição |
|---|---|
| **AgentBoard** | Nome do sistema de orquestração descrito neste documento |
| **Orchestrator** | Processo Node.js que faz polling do ADO e coordena os agentes |
| **OpenCode** | Ferramenta de AI coding agent utilizada para executar os comandos de desenvolvimento. [Docs](https://opencode.ai/docs) |
| **opencode serve** | Modo servidor do OpenCode, expõe HTTP API na porta 4096 |
| **SDK** | `@opencode-ai/sdk` — cliente oficial TypeScript para o opencode serve |
| **SSE** | Server-Sent Events — stream de eventos em tempo real do opencode serve |
| **PBI** | Product Backlog Item — unidade de trabalho no Azure DevOps |
| **DOR** | Definition of Readiness — critérios que um PBI deve atender antes do refinamento |
| **ADO** | Azure DevOps — plataforma de gestão de projeto e repositório |
| **PAT** | Personal Access Token — credencial de autenticação do ADO |
| **WIQL** | Work Item Query Language — linguagem de consulta do ADO |
| **Architecture-registry** | Registro de aplicações e dependências que mapeia componentes do sistema (front, back, APIM, repos, Swagger) |
| **State Store** | Componente de controle de locks por arquivo JSON local |
| **Lock** | Registro temporário que indica que um PBI está sendo processado |
| **TTL** | Time-To-Live — tempo de validade de um lock antes de expirar automaticamente |
| **LLM Resolver** | Mecanismo que usa LLM para decidir respostas a perguntas dos agentes |
| **Adaptive Card** | Formato de notificação interativa do Microsoft Teams |
| **Spec técnica** | Documento gerado pelo Tech Lead Agent com detalhes de implementação do PBI |
| **TDD** | Test-Driven Development — metodologia onde testes são criados antes da implementação |
| **Iteração agente-agente** | Ciclo de revisão-correção entre Tech Lead Agent e Developer Agent durante Review |
| **Session** | Contexto isolado de conversa com o agente OpenCode, criado e deletado por PBI |
| **HML** | Homologação — ambiente de pré-produção para testes e validação |
| **Azure Pipelines** | Serviço de CI/CD do Azure DevOps para build e deploy |

---

*Documento gerado em 14/03/2026 — AgentBoard v2.0*
