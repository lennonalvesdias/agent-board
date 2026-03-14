/**
 * OpenCodeRunner v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Usa o SDK oficial @opencode-ai/sdk ao invés de subprocess.
 *
 * Fluxo por execução:
 *  1. Cria uma sessão dedicada para o PBI/task
 *  2. Injeta contexto do work item (noReply: true — sem resposta do agente)
 *  3. Executa o comando via session.command()
 *  4. Escuta o stream SSE para:
 *     a. Eventos de permission → responde automaticamente (allow)
 *     b. Perguntas do agente (opção A / opção B) → LLM decide com contexto
 *  5. Aguarda conclusão e retorna resultado estruturado
 *  6. Deleta a sessão para não acumular histórico
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import { config } from "../config/index.js";

const BASE_URL = `http://127.0.0.1:${config.opencodePort}`;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Nome do comando OpenCode (validate-pbi, generate-spec, develop) */
  command:   string;
  /** Argumentos do comando — ex: ID do PBI ou da Task */
  args:      string[];
  /** Contexto completo do work item para injeção inicial e decisões do LLM */
  context:   WorkItemContext;
  /** Diretório de trabalho (para o opencode serve saber qual repo usar) */
  workdir?:  string;
}

export interface WorkItemContext {
  id:          number;
  title:       string;
  state:       string;
  description: string;
  acceptance?: string;
  techSpec?:   string;
  repo?:       string;
}

export interface RunResult {
  success:    boolean;
  command:    string;
  summary:    string;
  details?:   string;
  sessionId?: string;
  duration:   number;
}

// ─── Tipos locais para propriedades dos eventos SSE ──────────────────────────

/** Formato esperado das properties de eventos de permission do OpenCode */
interface PermissionEventProps {
  sessionID?:  string;
  permission?: { state?: string; id?: string };
}

/** Formato esperado das properties de eventos de mensagem do OpenCode */
interface MessageEventProps {
  sessionID?: string;
  message?:   { parts?: unknown[] };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export class OpenCodeRunner {
  private client = createOpencodeClient({ baseUrl: BASE_URL });

  async run(opts: RunOptions): Promise<RunResult> {
    const start = Date.now();
    let sessionId: string | undefined;

    console.log(`  → Executando comando: ${opts.command} ${opts.args.join(" ")}`);

    try {
      // 1. Cria sessão dedicada
      const sessionRes = await this.client.session.create({
        body: { title: `[AgentBoard] ${opts.command} #${opts.context.id}` },
      });

      if (!sessionRes.data) throw new Error("Falha ao criar sessão no OpenCode.");
      sessionId = sessionRes.data.id;
      console.log(`  ✓ Sessão criada: ${sessionId}`);

      // 2. Injeta contexto do work item (sem gerar resposta do agente)
      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          noReply: true,
          parts:   [{ type: "text", text: buildContextPrompt(opts.context) }],
        },
      });

      // 3. Executa o comando com timeout
      const result = await Promise.race([
        this.executeCommand(sessionId, opts),
        timeout(config.agentTimeoutMs, opts.command),
      ]);

      return { ...result, sessionId, duration: Date.now() - start };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✕ Erro na execução: ${msg}`);
      return {
        success:  false,
        command:  opts.command,
        summary:  msg,
        sessionId,
        duration: Date.now() - start,
      };
    } finally {
      // 6. Limpa sessão (não acumula histórico)
      if (sessionId) {
        await this.client.session.delete({ path: { id: sessionId } })
          .catch((err: unknown) => console.warn("[OpenCodeRunner] Falha ao deletar sessão:", err instanceof Error ? err.message : String(err)));
        console.log(`  ✓ Sessão ${sessionId} removida.`);
      }
    }
  }

  // ─── Execução do comando com listener SSE ──────────────────────────────────

  private async executeCommand(
    sessionId: string,
    opts:      RunOptions
  ): Promise<Omit<RunResult, "sessionId" | "duration">> {

    // Inicia o listener SSE em paralelo para capturar eventos enquanto o
    // comando está rodando (permission requests, perguntas do agente, etc.)
    const eventHandler = this.startEventListener(sessionId, opts.context);

    try {
      // Envia o comando — session.command() aguarda resposta completa (síncrono)
      const res = await this.client.session.command({
        path: { id: sessionId },
        body: {
          command:   opts.command,
          arguments: opts.args.join(" "),
          agent:     opts.command, // agente com mesmo nome do comando
        },
      });

      eventHandler.stop();

      if (!res.data) {
        return { success: false, command: opts.command, summary: "Sem resposta do agente." };
      }

      // Extrai texto da resposta
      const text = extractText(res.data.parts ?? []);
      const success = !isErrorResponse(text);

      console.log(`  ${success ? "✓" : "✕"} Comando concluído.`);

      return {
        success,
        command: opts.command,
        summary: extractSummary(text),
        details: success ? undefined : text.slice(-2000),
      };

    } catch (err) {
      eventHandler.stop();
      throw err;
    }
  }

  // ─── Listener SSE ─────────────────────────────────────────────────────────
  //
  // Escuta dois tipos de evento:
  //
  //  A) permission.updated
  //     → O agente pediu aprovação para executar uma ferramenta (bash, edit…)
  //     → Responde automaticamente com "always" pois o opencode.json já define
  //       permission: allow, mas casos residuais podem chegar aqui.
  //
  //  B) Mensagem de texto do agente que parece uma pergunta (opção A / opção B)
  //     → Chama resolveAgentQuestion() que usa o LLM com contexto do PBI
  //       para decidir a melhor resposta e continua a conversa.

  private startEventListener(sessionId: string, context: WorkItemContext) {
    let stopped = false;

    const listen = async () => {
      try {
        const events = await this.client.event.subscribe();
        for await (const raw of events.stream) {
          if (stopped) break;

          // Widening para acesso genérico às propriedades do evento SSE
          const ev = raw as { type: string; properties?: unknown };

          // A) Permission request residual
          if (ev.type === "permission.updated") {
            const props = ev.properties as PermissionEventProps | undefined;
            if (
              props?.sessionID === sessionId &&
              props?.permission?.state === "pending"
            ) {
              const permId = props.permission?.id;
              if (permId) {
                console.log(`  ↳ Permission request detectado (${permId}) — respondendo allow`);
                await this.client
                  .postSessionIdPermissionsPermissionId({
                    path: { id: sessionId, permissionID: permId },
                    body: { response: "always" },
                  })
                  .catch(console.warn);
              }
            }
          }

          // B) Mensagem do agente que parece uma pergunta de decisão
          if (ev.type === "message.completed") {
            const props = ev.properties as MessageEventProps | undefined;
            if (props?.sessionID === sessionId) {
              const parts: unknown[] = props?.message?.parts ?? [];
              const text  = extractText(parts);

              if (isAgentQuestion(text)) {
                console.log(`  ↳ Agente fez uma pergunta — resolvendo com contexto do PBI...`);
                const answer = await resolveAgentQuestion(text, context);
                console.log(`  ↳ Resposta decidida: ${answer.slice(0, 120)}...`);

                await this.client.session.prompt({
                  path: { id: sessionId },
                  body: { parts: [{ type: "text", text: answer }] },
                }).catch(console.warn);
              }
            }
          }
        }
      } catch {
        // SSE pode encerrar quando a sessão termina — comportamento esperado
      }
    };

    listen(); // roda em background, sem await

    return { stop: () => { stopped = true; } };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Monta o prompt de contexto injetado antes do comando (noReply: true) */
function buildContextPrompt(ctx: WorkItemContext): string {
  return [
    `## Contexto do Work Item — AgentBoard`,
    ``,
    `**ID:** #${ctx.id}`,
    `**Título:** ${ctx.title}`,
    `**Estado:** ${ctx.state}`,
    `**Repositório:** ${ctx.repo ?? "não informado"}`,
    ``,
    ctx.description ? `**Descrição:**\n${ctx.description}` : "",
    ctx.acceptance  ? `**Critérios de Aceite:**\n${ctx.acceptance}` : "",
    ctx.techSpec    ? `**Spec Técnica:**\n${ctx.techSpec}` : "",
    ``,
    `> Este contexto foi injetado automaticamente pelo AgentBoard Orchestrator.`,
    `> Execute o comando recebido com base nessas informações.`,
    `> Se precisar tomar uma decisão de implementação, escolha a opção mais`,
    `> simples, alinhada com os critérios de aceite, sem perguntar ao usuário.`,
  ].filter(Boolean).join("\n");
}

/**
 * Detecta se a mensagem do agente é uma pergunta esperando decisão humana.
 * Padrões comuns: "opção A ou B", "qual abordagem", "como você prefere", etc.
 */
function isAgentQuestion(text: string): boolean {
  const patterns = [
    /opção\s+(a|b|1|2)/i,
    /abordagem\s+(a|b|1|2)/i,
    /qual.*(prefer|escolh|opção|abordagem)/i,
    /como\s+você\s+(prefer|quer|gostaria)/i,
    /você\s+(prefer|quer|gostaria)/i,
    /should\s+i\s+(use|implement|choose)/i,
    /which\s+(approach|option|way)/i,
    /do\s+you\s+(want|prefer|need)/i,
    /\?\s*$/, // termina com "?"
  ];
  return patterns.some(p => p.test(text));
}

/**
 * Usa o modelo configurado para decidir a melhor resposta para uma pergunta
 * do agente, com base no contexto completo do PBI.
 *
 * Nota: usa a API Anthropic diretamente (não via OpenCode) para não criar
 * loop de sessão. Se quiser usar outro provider, substitua a chamada aqui.
 */
async function resolveAgentQuestion(
  question: string,
  context:  WorkItemContext
): Promise<string> {
  // Tenta responder via Anthropic API se disponível
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    // Fallback sem LLM: instrui o agente a usar o critério mais simples
    return (
      `Com base nos critérios de aceite do PBI #${context.id} ("${context.title}"), ` +
      `escolha a opção mais simples e direta que atenda os requisitos sem adicionar ` +
      `complexidade desnecessária. Prossiga com a implementação.`
    );
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            apiKey,
        "anthropic-version":    "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-20250514", // modelo leve para decisões rápidas
        max_tokens: 512,
        system: [
          "Você é um tech lead decidindo questões de implementação.",
          "Com base no contexto do PBI fornecido, responda a pergunta do agente de forma",
          "direta e objetiva, escolhendo a abordagem mais adequada.",
          "Não faça perguntas de volta. Forneça uma decisão clara e justificativa curta.",
        ].join(" "),
        messages: [{
          role:    "user",
          content: [
            `## PBI #${context.id} — ${context.title}`,
            ``,
            context.acceptance ? `**Critérios de aceite:** ${context.acceptance}` : "",
            context.techSpec   ? `**Spec técnica:** ${context.techSpec}` : "",
            ``,
            `## Pergunta do agente de desenvolvimento:`,
            question,
          ].filter(Boolean).join("\n"),
        }],
      }),
    });

    const data: unknown = await res.json();
    const content = (data as { content?: Array<{ text?: string }> })?.content;
    const text    = content?.[0]?.text;
    if (typeof text === "string" && text.length > 0) return text;
    return fallbackDecision(context);
  } catch {
    return fallbackDecision(context);
  }
}

function fallbackDecision(context: WorkItemContext): string {
  return (
    `Prossiga com a implementação mais simples que satisfaça os critérios de aceite ` +
    `do PBI #${context.id}. Evite over-engineering. Se houver duas opções equivalentes, ` +
    `prefira a que usa padrões já estabelecidos no projeto.`
  );
}

function extractText(parts: unknown[]): string {
  return parts
    .filter((p): p is { type: string; text?: string } =>
      typeof p === "object" && p !== null && (p as Record<string, unknown>)["type"] === "text"
    )
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

function extractSummary(text: string): string {
  // Tenta linha "SUMMARY: ..." (convenção opcional nos seus comandos)
  const match = text.match(/^SUMMARY:\s*(.+)$/m);
  if (match) return match[1].trim();
  // Fallback: último parágrafo não-vazio, máx 400 chars
  const paragraphs = text.split(/\n{2,}/).filter(Boolean);
  return (paragraphs.at(-1) ?? text).trim().slice(0, 400);
}

function isErrorResponse(text: string): boolean {
  return /\b(error|falha|failed|exception|not found|não encontrado)\b/i.test(text) &&
    !/corrigido|resolvido|fixed/i.test(text);
}

function timeout(ms: number, command: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s) no comando: ${command}`)), ms)
  );
}
