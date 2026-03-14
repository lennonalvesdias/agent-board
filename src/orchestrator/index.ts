/**
 * AgentBoard Orchestrator v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Loop de polling que monitora o ADO board e delega para o OpenCodeRunner,
 * que usa o SDK oficial (@opencode-ai/sdk) via HTTP API.
 *
 * Pré-requisito: `opencode serve` deve estar rodando na porta configurada.
 * Os scripts de start (start.sh / start.ps1) garantem isso automaticamente.
 */

import { ADOClient }       from "../ado/client.js";
import { OpenCodeRunner }  from "./opencode-runner.js";
import { TeamsNotifier }   from "../notify/teams.js";
import { StateStore }      from "./state-store.js";
import { config }          from "../config/index.js";
import type { WorkItemContext } from "./opencode-runner.js";
import type { PullRequest }     from "../ado/client.js";

const ado    = new ADOClient();
const runner = new OpenCodeRunner();
const notify = new TeamsNotifier();
const store  = new StateStore();

// ─── Pipeline de estados ─────────────────────────────────────────────────────
const PIPELINE: Record<string, { role: string; command: string; nextState: string }> = {
  "New":        { role: "techlead", command: "validate-pbi",   nextState: "Approved"   },
  "Approved":   { role: "techlead", command: "generate-specs", nextState: "Commited"   },
  "Commited":   { role: "dev",      command: "assign",         nextState: "InProgress" },
  "InProgress": { role: "dev",      command: "develop",        nextState: "Review"     },
  "Review":     { role: "techlead", command: "analyse-pr",     nextState: "Done"       },
};

// ─── Ciclo principal ──────────────────────────────────────────────────────────
async function runCycle(): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] ──── Ciclo de polling ────`);

  // Valida que o opencode serve está acessível antes de processar
  if (!await isOpencodeAlive()) {
    console.error(`[Orchestrator] opencode serve não está acessível em :${config.opencodePort}. Aguardando próximo ciclo.`);
    return;
  }

  let workItems: Awaited<ReturnType<typeof ado.getWorkItems>>;
  try {
    workItems = await ado.getWorkItems({ states: Object.keys(PIPELINE), types: ["Product Backlog Item"] });
  } catch (err) {
    console.error("[Orchestrator] Falha ao buscar ADO:", err);
    return;
  }

  console.log(`[Orchestrator] ${workItems.length} PBI(s) elegíveis.`);

  for (const wi of workItems) {
    const step = PIPELINE[wi.state];
    if (!step) continue;

    const lockKey = `${wi.id}:${wi.state}`;
    if (await store.isLocked(lockKey)) {
      console.log(`  [PBI ${wi.id}] Lock ativo — pulando.`);
      continue;
    }
    await store.lock(lockKey, config.lockTtlMinutes);

    try {
      await processPBI(wi, step);
    } catch (err) {
      console.error(`  [PBI ${wi.id}] Erro:`, err);
      await notify.error(wi, err instanceof Error ? err : new Error(String(err)));
      await store.unlock(lockKey);
    }
  }

  console.log(`[${new Date().toISOString()}] ──── Ciclo concluído ────`);
}

// ─── Processamento por PBI ────────────────────────────────────────────────────
async function processPBI(
  wi:   WorkItem,
  step: typeof PIPELINE[string]
): Promise<void> {
  console.log(`  [PBI ${wi.id}] "${wi.title}" | ${wi.state} → ${step.role}`);
  await notify.agentStarted(wi, step.role, step.command);

  const context = buildContext(wi);

  // ── Commited: assign ao dev, sem OpenCode ────────────────────────────────
  if (wi.state === "Commited") {
    await ado.assignWorkItem(wi.id, "Developer Agent");
    await ado.addTag(wi.id, "dev-assigned");
    await ado.transition(wi.id, "InProgress");
    await notify.pbiTransitioned(wi, "InProgress", step.role);
    return;
  }

  // ── InProgress: processa tasks filhas ────────────────────────────────────
  if (wi.state === "InProgress") {
    await processInProgressTasks(wi, step, context);
    return;
  }

  // ── Review: analisa PRs via OpenCode ─────────────────────────────────────
  if (wi.state === "Review") {
    await processReviewState(wi, context);
    return;
  }

  // ── New / Approved: executa comando OpenCode ──────────────────────────────
  const result = await runner.run({
    command: step.command,
    args:    [wi.id.toString()],
    context,
  });

  if (result.success) {
    await ado.transition(wi.id, step.nextState);
    const successTag = wi.state === "New" ? "dor-validated" : "spec-ready";
    await ado.addTag(wi.id, successTag);
    await notify.pbiTransitioned(wi, step.nextState, step.role);
  } else {
    const failTag = wi.state === "New" ? "dor-blocked" : "spec-blocked";
    await ado.addTag(wi.id, failTag);
    await ado.addComment(wi.id, buildBlockComment(result, step.role));
    await notify.pbiBlocked(wi, step.role, result.summary);
    await store.unlock(`${wi.id}:${wi.state}`);
  }
}

// ─── InProgress: processa tasks filhas via OpenCode ──────────────────────────
async function processInProgressTasks(
  wi:      WorkItem,
  step:    typeof PIPELINE[string],
  context: WorkItemContext
): Promise<void> {
  const tasks        = await ado.getChildTasks(wi.id);
  const pendingTasks = tasks.filter(t => t.state === "To Do");

  if (!pendingTasks.length) {
    console.log(`    Sem tasks pendentes em #${wi.id}.`);
    return;
  }

  for (const task of pendingTasks) {
    console.log(`    [Task ${task.id}] "${task.title}"`);

    const taskContext: WorkItemContext = {
      ...context,
      id:       task.id,
      title:    task.title,
      state:    task.state,
      repo:     (task.fields["Custom.Repository"] as string | undefined) ?? context.repo,
      techSpec: task.fields["System.Description"] as string | undefined,
    };

    const result = await runner.run({
      command: "develop",
      args:    [task.id.toString()],
      context: taskContext,
    });

    await ado.updateTask(task.id, {
      state:   result.success ? "In Progress" : "Blocked",
      comment: result.summary,
    });

    if (result.success) {
      await ado.addTag(wi.id, "pr-opened");
    } else {
      await ado.addTag(wi.id, "dev-blocked");
    }

    await notify.taskResult(wi, task, result);
  }

  const allStarted = (await ado.getChildTasks(wi.id)).every(t => t.state !== "To Do");
  if (allStarted) {
    await ado.transition(wi.id, step.nextState);
    await notify.pbiTransitioned(wi, step.nextState, step.role);
  }
}

// ─── Review: analisa PRs abertos via OpenCode ────────────────────────────────
async function processReviewState(
  wi:      WorkItem,
  context: WorkItemContext
): Promise<void> {
  const prs = await ado.getPullRequests(wi.id);

  if (!prs.length) {
    console.log(`  [PBI ${wi.id}] Sem PRs encontrados — aguardando próximo ciclo.`);
    await store.unlock(`${wi.id}:${wi.state}`);
    return;
  }

  const reviewCount = store.incrementReviewCount(wi.id);
  console.log(`  [PBI ${wi.id}] Review iteração #${reviewCount}`);

  // Escalação após 3 tentativas sem aprovação
  if (reviewCount >= 3) {
    await ado.addTag(wi.id, "pr-needs-human");
    await notify.error(wi, new Error(`PR precisa de revisão humana após ${reviewCount} iterações.`));
    await store.unlock(`${wi.id}:${wi.state}`);
    return;
  }

  for (const pr of prs) {
    console.log(`    [PR ${pr.pullRequestId}] "${pr.title}"`);

    const result = await runner.run({
      command: "analyse-pr",
      args:    [pr.pullRequestId.toString()],
      context: { ...context, description: `PR #${pr.pullRequestId}: ${pr.title}` },
    });

    if (result.success) {
      await ado.addTag(wi.id, "pr-approved");
      await ado.transition(wi.id, "Done");
      await notify.pbiTransitioned(wi, "Done", "techlead");
      store.resetReviewCount(wi.id);
      return;
    } else {
      await ado.addTag(wi.id, "pr-changes-requested");
      await ado.addComment(wi.id, buildBlockComment(result, "techlead"));
      await notify.pbiBlocked(wi, "techlead", result.summary);
      await store.unlock(`${wi.id}:${wi.state}`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildContext(wi: WorkItem): WorkItemContext {
  return {
    id:          wi.id,
    title:       wi.title,
    state:       wi.state,
    description: (wi.fields["System.Description"]        as string | undefined) ?? "",
    acceptance:  (wi.fields["Microsoft.VSTS.Common.AcceptanceCriteria"] as string | undefined) ?? "",
    techSpec:    wi.fields["Custom.TechSpec"]            as string ?? "",
    repo:        wi.fields["Custom.Repository"]          as string ?? "",
  };
}

function buildBlockComment(result: { command: string; summary: string; details?: string }, role: string): string {
  return [
    `## 🤖 AgentBoard — Bloqueio`,
    `| Campo | Valor |`,
    `|---|---|`,
    `| Agente | ${agentLabel(role)} |`,
    `| Comando | \`${result.command}\` |`,
    `| Motivo | ${result.summary} |`,
    result.details ? `\n**Output:**\n\`\`\`\n${result.details.slice(0, 1500)}\n\`\`\`` : "",
    `\n> Corrija as pendências. O agente tentará novamente no próximo ciclo (${config.pollingIntervalMs / 60000} min).`,
  ].join("\n");
}

function agentLabel(role: string): string {
  return ({ pm: "PM Agent", techlead: "TechLead Agent", dev: "Dev Agent" } as Record<string, string>)[role] ?? role;
}

async function isOpencodeAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.opencodePort}/global/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Tipos exportados ─────────────────────────────────────────────────────────
export interface WorkItem {
  id:          number;
  title:       string;
  state:       string;
  type:        string;
  assignedTo?: string;
  fields:      Record<string, unknown>;
}
export interface Task extends WorkItem { parentId: number; }

// ─── Entry point ──────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   AgentBoard Orchestrator  v2.0          ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Projeto ADO  : ${config.ado.org}/${config.ado.project}`);
  console.log(`  OpenCode     : http://127.0.0.1:${config.opencodePort}`);
  console.log(`  Polling      : ${config.pollingIntervalMs / 1000}s`);
  console.log(`  Workspace    : ${config.workspaceRoot}`);
  console.log(`  Teams        : ${config.teams.enabled ? "ativado" : "desabilitado"}`);
  console.log("");

  await runCycle();
  setInterval(runCycle, config.pollingIntervalMs);
}

start().catch(err => { console.error("Erro fatal:", err); process.exit(1); });
