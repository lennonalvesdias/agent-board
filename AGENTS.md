# AGENTS.md — AgentBoard Orchestrator v2

> Operational guide for AI coding agents working in this repository.
> This project runs in **fully automated, non-interactive mode**. No user is present during sessions.

---

## 1. Project Overview

AgentBoard Orchestrator polls Azure DevOps for PBIs, delegates work to OpenCode agents, tracks state, and notifies via Teams webhooks.

**Stack:** Node.js 18+, TypeScript 5.4, ESM (`"type": "module"`), `tsx` runner

```
src/
├── ado/client.ts              # Azure DevOps REST API client
├── config/index.ts            # .env config loader
├── notify/teams.ts            # Teams webhook notifications
└── orchestrator/
    ├── index.ts               # Main polling loop (entry point)
    ├── opencode-runner.ts     # OpenCode SDK integration
    └── state-store.ts         # Lock/state management
scripts/
  start.sh / start.ps1         # Full startup scripts
opencode-config/
  opencode.json                # OpenCode serve config
  AGENTS.md                    # Agent automation rules (DO NOT overwrite)
```

---

## 2. Build & Run Commands

```bash
npm start          # Run orchestrator via tsx (no build needed)
npm run dev        # Watch mode — auto-restarts on file changes
npm run build      # Compile TypeScript → dist/
npm run start:js   # Run compiled output from dist/
npx tsc --noEmit   # Type-check only (no output)
```

**No test framework.** No Jest, Vitest, or any test runner is configured.  
**No linter.** No ESLint or Prettier configured.  
Verification = `npx tsc --noEmit` passing clean.

---

## 3. TypeScript & Type Checking

```json
{
  "target": "ES2022",
  "module": "ESNext",
  "moduleResolution": "bundler",
  "strict": true,
  "esModuleInterop": true
}
```

**Rules:**
- `strict: true` — all code must pass under strict mode, no exceptions
- All function parameters must be explicitly typed
- All return types must be explicitly declared
- Use `unknown` for external/API data — never `any`
- Use `Record<string, T>` for object maps
- Handle errors with: `err instanceof Error ? err.message : String(err)`
- Use `import type` for type-only imports

---

## 4. Code Style Guidelines

### Imports

ESM `.js` extensions are **required** on all relative imports, even for `.ts` source files:

```typescript
import { ADOClient } from "../ado/client.js";
import type { WorkItemContext } from "./opencode-runner.js";
```

Visual alignment with extra spaces is acceptable (cosmetic, matches existing style).

### Naming Conventions

| Construct | Convention | Example |
|---|---|---|
| Classes | PascalCase | `ADOClient`, `StateStore` |
| Functions/methods | camelCase | `runCycle`, `processPBI` |
| Constants | UPPER_SNAKE_CASE | `STATE_FILE`, `BASE` |
| Interfaces/Types | PascalCase | `WorkItem`, `RunResult` |
| Variables | camelCase, descriptive | `pendingTasks`, `lockKey` |

### Error Handling

- All async operations wrapped in `try/catch` — never swallow errors silently
- Error logs always include a context tag: `console.error("[Orchestrator] ...", err)`
- API errors throw with full context: method, status, URL, and response body
- On error: unlock state → log → notify → return
- Use `Promise.race` with a timeout helper for agent operations

### Comments & Logging

- Each file begins with a JSDoc/block header explaining its purpose
- Section separators use Unicode lines: `// ─── Section name ──────────`
- `console.log` uses context markers: `[Orchestrator]`, `[PBI ${id}]`
- Comments may be written in Portuguese — this is expected and acceptable

---

## 5. File Organization

- **One class/module per file** — no bundling unrelated logic
- Related types are exported from the same file as the implementation
- Utility/helper functions belong at the bottom of the file they support
- Do not create new top-level directories without a clear architectural reason

---

## 6. Agent Automation Rules

### Non-Interactive Mode

**Never ask the user questions.** There is no user present in the session.

When a decision is required:
1. Read the acceptance criteria from the PBI (injected into session context)
2. Read existing project patterns from source code
3. Choose the option that best meets criteria with **minimum complexity**
4. Document the decision in a code comment
5. **Do not ask — implement**

If there is ambiguity between approaches, **prefer existing project patterns**.

If there is a real blocker (missing credential, missing architecture file, unresolvable conflict), end the session with:

```
SUMMARY: BLOQUEIO — <reason>
```

### Mandatory Output Format

**Every session must end with a SUMMARY line** (max 200 chars):

```
SUMMARY: <short description of what was done or why it was blocked>
```

**Examples:**

```
SUMMARY: DOR validado — 4 critérios de aceite completos. PBI pronto para refinamento.
SUMMARY: PR #847 criado — branch feature/1265-carrinho-live, 3 arquivos modificados.
SUMMARY: BLOQUEIO — arquivo architecture/notifications.md não encontrado.
```

### Architecture Registry

Before generating technical specs or making structural decisions, check `docs/architecture/` (or the path referenced in the PBI) for existing decision records.

### Verification Before Finishing

Before ending a coding session, always run:

```bash
npx tsc --noEmit
```

All type errors must be resolved. If type errors cannot be resolved without broader architectural changes, escalate with `SUMMARY: BLOQUEIO — <reason>` rather than leaving broken code.
