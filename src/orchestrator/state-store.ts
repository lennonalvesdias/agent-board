/**
 * StateStore — controle de locks por arquivo JSON local.
 * Para escalar ao Azure: troque por @azure/data-tables mantendo a mesma interface.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve }                                  from "path";

const STATE_FILE = resolve(process.cwd(), ".agentboard-state.json");

interface LockEntry  { kind: "lock";  lockedAt: number; expiresAt: number }
interface CountEntry { kind: "count"; lockedAt: number; expiresAt: number; count: number }
type Entry = LockEntry | CountEntry;

export class StateStore {
  private data: Record<string, Entry> = {};

  constructor() { this.load(); }

  async isLocked(key: string): Promise<boolean> {
    this.cleanup();
    const e = this.data[key];
    return Boolean(e && Date.now() < e.expiresAt);
  }

  async lock(key: string, ttlMinutes: number): Promise<void> {
    this.data[key] = { kind: "lock", lockedAt: Date.now(), expiresAt: Date.now() + ttlMinutes * 60_000 };
    this.save();
  }

  async unlock(key: string): Promise<void> {
    delete this.data[key];
    this.save();
  }

  /** Retorna contador de iterações de review para um PBI */
  getReviewCount(pbiId: number): number {
    this.cleanup();
    const key   = `review-count:${pbiId}`;
    const entry = this.data[key];
    if (!entry) return 0;
    if (entry.kind === "count") return entry.count;
    return 0;
  }

  /** Incrementa e retorna contador de iterações de review */
  incrementReviewCount(pbiId: number): number {
    const key     = `review-count:${pbiId}`;
    const current = this.getReviewCount(pbiId);
    const next    = current + 1;
    // Armazena com TTL de 7 dias
    this.data[key] = { kind: "count", lockedAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, count: next };
    this.save();
    return next;
  }

  /** Reset contador de review (usado após aprovação) */
  resetReviewCount(pbiId: number): void {
    const key = `review-count:${pbiId}`;
    delete this.data[key];
    this.save();
  }

  private cleanup() {
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(this.data)) {
      if (this.data[k].expiresAt < now) { delete this.data[k]; changed = true; }
    }
    if (changed) this.save();
  }

  private load() {
    if (existsSync(STATE_FILE)) {
      try { this.data = JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch (err) {
        console.warn("[StateStore] Falha ao ler state file — reiniciando:", err instanceof Error ? err.message : String(err));
        this.data = {};
      }
    }
  }

  private save() {
    writeFileSync(STATE_FILE, JSON.stringify(this.data, null, 2));
  }
}
