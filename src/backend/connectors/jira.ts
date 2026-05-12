import * as fs from "fs";
import * as path from "path";
import type { IConnector, ConnectorProject, TimeEntry, ProjectMapping } from "../../shared/types.js";

interface JiraSecrets {
  jira: { baseUrl: string; email: string; apiToken: string };
}

function loadSecrets(): JiraSecrets {
  const p = path.join(process.cwd(), "secrets.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export class JiraConnector implements IConnector {
  name = "jira";
  private _accountId: string | null = null;

  private get config() {
    return loadSecrets().jira;
  }

  private get authHeader() {
    const { email, apiToken } = this.config;
    return "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  private async getAccountId(): Promise<string> {
    if (this._accountId) return this._accountId;
    const data = await this.request("GET", "/rest/api/3/myself");
    this._accountId = data.accountId;
    return this._accountId!;
  }

  private async request(method: string, urlPath: string, body?: any): Promise<any> {
    const { baseUrl } = this.config;
    const url = `${baseUrl}${urlPath}`;
    const headers: Record<string, string> = {
      "Authorization": this.authHeader,
      "Accept": "application/json",
    };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira ${method} ${urlPath} → ${res.status}: ${text.substring(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async getProjects(): Promise<ConnectorProject[]> {
    const data = await this.request("GET", "/rest/api/3/project/search?maxResults=100&orderBy=name");
    return (data.values ?? []).map((p: any) => ({ id: p.key, name: p.name }));
  }

  async getIssues(projectKey: string): Promise<Array<{ key: string; summary: string }>> {
    const jql = `project = "${projectKey}" AND statusCategory != Done ORDER BY updated DESC`;
    const data = await this.request("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: 50,
      fields: ["summary"],
    });
    return (data.issues ?? [])
      .map((i: any) => ({ key: i.key, summary: i.fields?.summary ?? "" }))
      .sort((a: any, b: any) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  async getEntries(_from: string, _to: string): Promise<TimeEntry[]> { return []; }

  async getWorklogs(issueKey: string, from: string, to: string): Promise<Array<{ id: string; date: string; hours: number }>> {
    const accountId = await this.getAccountId();
    const results: Array<{ id: string; date: string; hours: number }> = [];
    let startAt = 0;
    const pageSize = 1000;
    while (true) {
      const data = await this.request("GET", `/rest/api/3/issue/${issueKey}/worklog?maxResults=${pageSize}&startAt=${startAt}`);
      const worklogs: any[] = data.worklogs ?? [];
      for (const w of worklogs) {
        if (w.author?.accountId !== accountId) continue;
        const date = w.started?.substring(0, 10) ?? "";
        if (date >= from && date <= to) {
          results.push({ id: String(w.id), date, hours: w.timeSpentSeconds / 3600 });
        }
      }
      if (startAt + worklogs.length >= (data.total ?? 0)) break;
      startAt += worklogs.length;
    }
    return results;
  }

  async deleteWorklog(issueKey: string, worklogId: string): Promise<void> {
    await this.request("DELETE", `/rest/api/3/issue/${issueKey}/worklog/${worklogId}`);
  }

  async pushEntry(entry: TimeEntry, mapping: ProjectMapping): Promise<string> {
    if (!mapping.jira) throw new Error("No Jira mapping for project");
    const issueKey = mapping.jira.issueKey ?? mapping.jira.projectKey;
    const started = `${entry.date}T09:00:00.000+0000`;
    const body: any = {
      timeSpentSeconds: Math.round(entry.hours * 3600),
      started,
    };
    if (entry.description) {
      body.comment = {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: entry.description }] }],
      };
    }
    const data = await this.request("POST", `/rest/api/3/issue/${issueKey}/worklog`, body);
    return String(data.id);
  }

  async updateEntry(externalId: string, entry: TimeEntry, mapping: ProjectMapping): Promise<void> {
    if (!mapping.jira) throw new Error("No Jira mapping for project");
    const issueKey = mapping.jira.issueKey ?? mapping.jira.projectKey;
    const body: any = {
      timeSpentSeconds: Math.round(entry.hours * 3600),
      started: `${entry.date}T09:00:00.000+0000`,
    };
    if (entry.description) {
      body.comment = {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: entry.description }] }],
      };
    }
    await this.request("PUT", `/rest/api/3/issue/${issueKey}/worklog/${externalId}`, body);
  }

  async deleteEntry(externalId: string): Promise<void> {
    // Need issue key to delete — store it in externalId as "ISSUE-1:worklogId"
    const [issueKey, worklogId] = externalId.split(":");
    if (!worklogId) throw new Error("Jira external ID must be in format 'ISSUE-1:worklogId'");
    await this.request("DELETE", `/rest/api/3/issue/${issueKey}/worklog/${worklogId}`);
  }
}
