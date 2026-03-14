/**
 * ADOClient — Azure DevOps REST API v7.1
 */

import { config }    from "../config/index.js";
import type { WorkItem, Task } from "../orchestrator/index.js";

const BASE = `https://dev.azure.com/${config.ado.org}/${config.ado.project}`;

// ─── Tipos exportados ─────────────────────────────────────────────────────────

export interface PullRequest {
  pullRequestId: number;
  title:         string;
  status:        string;
  url:           string;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function headers(): Record<string, string> {
  return {
    "Content-Type":  "application/json",
    "Authorization": `Basic ${Buffer.from(`:${config.ado.pat}`).toString("base64")}`,
  };
}

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ADO ${res.status} ${res.statusText} — ${url}\n${body}`);
  }
  return res;
}

export class ADOClient {
  async getWorkItems(opts: { states: string[]; types: string[] }): Promise<WorkItem[]> {
    const stateList = opts.states.map(s => `'${s}'`).join(", ");
    const typeList  = opts.types.map(t  => `'${t}'`).join(", ");

    const res  = await apiFetch(`${BASE}/_apis/wit/wiql?api-version=7.1`, {
      method: "POST",
      body:   JSON.stringify({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN (${typeList}) AND [System.State] IN (${stateList}) AND [System.TeamProject]='${config.ado.project}' ORDER BY [System.ChangedDate] ASC`,
      }),
    });
    const data = await res.json() as { workItems?: { id: number }[] };
    if (!data.workItems?.length) return [];

    return this.fetchDetails(data.workItems.map(w => w.id).join(","));
  }

  async getChildTasks(parentId: number): Promise<Task[]> {
    const res  = await apiFetch(`${BASE}/_apis/wit/workitems/${parentId}?$expand=relations&api-version=7.1`);
    const data = await res.json() as { relations?: { rel: string; url: string }[] };

    const childIds = (data.relations ?? [])
      .filter(r => r.rel === "System.LinkTypes.Hierarchy-Forward")
      .map(r => r.url.split("/").pop())
      .filter((id): id is string => Boolean(id))
      .join(",");

    if (!childIds) return [];
    const details = await this.fetchDetails(childIds);
    return details.map(d => ({ ...d, parentId })) as Task[];
  }

  async transition(id: number, newState: string): Promise<void> {
    await this.patch(id, [{ op: "add", path: "/fields/System.State", value: newState }]);
    console.log(`    ✓ PBI #${id} → "${newState}"`);
  }

  async updateTask(id: number, opts: { state?: string; comment?: string }): Promise<void> {
    const ops: unknown[] = [];
    if (opts.state)   ops.push({ op: "add", path: "/fields/System.State",   value: opts.state });
    if (opts.comment) ops.push({ op: "add", path: "/fields/System.History", value: opts.comment });
    if (ops.length)   await this.patch(id, ops);
  }

  async addComment(id: number, text: string): Promise<void> {
    await apiFetch(`${BASE}/_apis/wit/workitems/${id}/comments?api-version=7.1-preview.3`, {
      method: "POST", body: JSON.stringify({ text }),
    });
  }

  async addTag(id: number, tag: string): Promise<void> {
    const res     = await apiFetch(`${BASE}/_apis/wit/workitems/${id}?api-version=7.1`);
    const item    = await res.json() as { fields: Record<string, unknown> };
    const current = (item.fields["System.Tags"] as string | undefined) ?? "";
    const tags    = current ? `${current}; ${tag}` : tag;
    await this.patch(id, [{ op: "add", path: "/fields/System.Tags", value: tags }]);
  }

  async assignWorkItem(id: number, user: string): Promise<void> {
    await this.patch(id, [{ op: "add", path: "/fields/System.AssignedTo", value: user }]);
  }

  async getPullRequests(workItemId: number): Promise<PullRequest[]> {
    const res  = await apiFetch(
      `${BASE}/_apis/git/repositories/pullrequests?searchCriteria.workItemRefs=${workItemId}&api-version=7.1`
    );
    const data = await res.json() as {
      value?: Array<{
        pullRequestId: number;
        title:         string;
        status:        string;
        _links:        { web: { href: string } };
      }>;
    };
    return (data.value ?? []).map((pr) => ({
      pullRequestId: pr.pullRequestId,
      title:         pr.title,
      status:        pr.status,
      url:           pr._links?.web?.href ?? "",
    }));
  }

  private async fetchDetails(ids: string): Promise<WorkItem[]> {
    const res  = await apiFetch(`${BASE}/_apis/wit/workitems?ids=${ids}&$expand=fields&api-version=7.1`);
    const data = await res.json() as { value?: Record<string, unknown>[] };
    return (data.value ?? []).map(raw => {
      const f = raw["fields"] as Record<string, unknown>;
      return {
        id:         raw["id"] as number,
        title:      f["System.Title"] as string,
        state:      f["System.State"] as string,
        type:       f["System.WorkItemType"] as string,
        assignedTo: (f["System.AssignedTo"] as { displayName?: string } | undefined)?.displayName,
        fields:     f,
      };
    });
  }

  private async patch(id: number, ops: unknown[]): Promise<void> {
    await apiFetch(`${BASE}/_apis/wit/workitems/${id}?api-version=7.1`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body:    JSON.stringify(ops),
    });
  }
}
