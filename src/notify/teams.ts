/**
 * TeamsNotifier — Adaptive Cards via Incoming Webhook
 */

import { config }    from "../config/index.js";
import type { WorkItem, Task } from "../orchestrator/index.js";
import type { RunResult }      from "../orchestrator/opencode-runner.js";

export class TeamsNotifier {
  private async send(card: unknown): Promise<void> {
    if (!config.teams.enabled) return;
    try {
      await fetch(config.teams.webhookUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          type: "message",
          attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
        }),
      });
    } catch (err) { console.warn("[Teams] Falha:", err); }
  }

  async agentStarted(wi: WorkItem, role: string, command: string) {
    const label = agentLabel(role);
    await this.send(card([
      tb(`${EMOJI[label] ?? "🤖"} ${label} iniciado`, "Bolder", "Medium", COLOR[label]),
      fs([{ title: "PBI", value: `#${wi.id} — ${wi.title}` }, { title: "Comando", value: `\`${command}\`` }]),
    ]));
  }

  async pbiTransitioned(wi: WorkItem, newState: string, role: string) {
    await this.send(card([
      tb(`✅ PBI #${wi.id} → ${newState}`, "Bolder", "Medium", "good"),
      fs([{ title: "PBI", value: wi.title }, { title: "Agente", value: agentLabel(role) }]),
      as([ou("Ver no ADO", adoUrl(wi.id))]),
    ]));
  }

  async taskResult(wi: WorkItem, task: Task, result: RunResult) {
    await this.send(card([
      tb(result.success ? "⚙️ Task implementada" : "⚠️ Task com falha", "Bolder", "Medium", result.success ? "good" : "warning"),
      fs([
        { title: "PBI",    value: `#${wi.id}` },
        { title: "Task",   value: `#${task.id} — ${task.title}` },
        { title: "Resumo", value: result.summary },
      ]),
      as([ou("Ver Task", adoUrl(task.id))]),
    ]));
  }

  async pbiBlocked(wi: WorkItem, role: string, reason: string) {
    await this.send(card([
      tb(`🔴 PBI #${wi.id} bloqueado`, "Bolder", "Medium", "attention"),
      fs([{ title: "PBI", value: `#${wi.id} — ${wi.title}` }, { title: "Motivo", value: reason }]),
      as([ou("Ver comentário", adoUrl(wi.id))]),
    ]));
  }

  async error(wi: WorkItem, err: Error) {
    await this.send(card([
      tb(`🔥 Erro inesperado — PBI #${wi.id}`, "Bolder", "Medium", "attention"),
      fs([{ title: "PBI", value: `#${wi.id}` }, { title: "Erro", value: err.message.slice(0, 300) }]),
    ]));
  }
}

// ─── Adaptive Card builders ───────────────────────────────────────────────────
const card = (body: unknown[]) => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard", version: "1.4", body,
});
const tb = (text: string, weight = "Default", size = "Default", color = "Default") =>
  ({ type: "TextBlock", text, weight, size, color, wrap: true });
const fs = (facts: { title: string; value: string }[]) => ({ type: "FactSet", facts });
const as = (actions: unknown[]) => ({ type: "ActionSet", actions });
const ou = (title: string, url: string) => ({ type: "Action.OpenUrl", title, url });
const adoUrl = (id: number) =>
  `https://dev.azure.com/${config.ado.org}/${config.ado.project}/_workitems/edit/${id}`;
const agentLabel = (role: string) =>
  ({ pm: "PM Agent", techlead: "TechLead Agent", dev: "Dev Agent" } as Record<string, string>)[role] ?? role;
const EMOJI: Record<string, string> = { "PM Agent": "🎯", "TechLead Agent": "🏗️", "Dev Agent": "⚙️" };
const COLOR: Record<string, string> = { "PM Agent": "warning", "TechLead Agent": "accent", "Dev Agent": "good" };
