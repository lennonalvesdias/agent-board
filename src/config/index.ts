/**
 * Configuração central do AgentBoard v2.
 * Todas as variáveis lidas do .env na raiz do projeto.
 */

import { config as loadDotenv } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
} else {
  console.warn("[Config] .env não encontrado — usando variáveis do sistema.");
}

function req(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Variável obrigatória não definida: ${key}\nCopie .env.example para .env e preencha.`);
  return val;
}

export const config = {
  /** Intervalo de polling em ms (padrão: 5 min) */
  pollingIntervalMs: Number(process.env["POLLING_INTERVAL_MS"] ?? 5 * 60 * 1000),

  /** TTL dos locks de PBI em minutos (padrão: 30) */
  lockTtlMinutes: Number(process.env["LOCK_TTL_MINUTES"] ?? 30),

  /** Timeout para o agente concluir uma tarefa (padrão: 30 min) */
  agentTimeoutMs: Number(process.env["AGENT_TIMEOUT_MS"] ?? 30 * 60 * 1000),

  /** Porta do opencode serve */
  opencodePort: Number(process.env["OPENCODE_PORT"] ?? 4096),

  /** Raiz dos repositórios clonados */
  workspaceRoot: process.env["WORKSPACE_ROOT"] ?? (
    process.platform === "win32"
      ? `${process.env["USERPROFILE"]}\\repos`
      : `${process.env["HOME"]}/repos`
  ),

  ado: {
    org:     req("ADO_ORG"),
    project: req("ADO_PROJECT"),
    pat:     req("ADO_PAT"),
  },

  opencode: {
    /** Modelo padrão injetado via OPENCODE_CONFIG_CONTENT se não houver opencode.json */
    model: process.env["OPENCODE_MODEL"] ?? "github/copilot",
  },

  teams: {
    enabled:    Boolean(process.env["TEAMS_WEBHOOK_URL"]),
    webhookUrl: process.env["TEAMS_WEBHOOK_URL"] ?? "",
  },
};
