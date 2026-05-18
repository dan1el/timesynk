import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as db from "../db.js";
import type { IConnector, ConnectorProject, ConnectorActivity, TimeEntry, ProjectMapping } from "../../shared/types.js";

interface Secrets {
  tripletex: { username: string; password: string };
}

function loadSecrets(): Secrets {
  const p = path.join(process.cwd(), "secrets.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// Filter out absence/admin activities not relevant for customer project timelogging
const ABSENCE_KEYWORDS = ["ferie", "syk", "sykt barn", "permisjon", "lege", "tannlege", "avspasering", "helligdag", "fri"];
function isAbsenceActivity(name: string): boolean {
  const lower = name.toLowerCase();
  return ABSENCE_KEYWORDS.some((kw) => lower.includes(kw));
}

interface Session {
  cookieHeader: string;
  csrfToken: string;
  contextId: string;
  employeeId: string;
  expiresAt: number;
}

// Sessions are persisted to SQLite so they survive server restarts.
// In-memory copy avoids a DB read on every call.
let sharedSession: Session | null = null;
let loginPromise: Promise<Session> | null = null;

// Sessions last up to 8 hours; 401 responses trigger immediate re-login.
const SESSION_TTL_MS = 8 * 60 * 60_000;

async function createSession(): Promise<Session> {
  const secrets = loadSecrets();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://tripletex.no/execute/login", { waitUntil: "domcontentloaded" });

    // Dismiss cookie popup (up to 2 layers)
    const accept = page.locator([
      'button:has-text("Accept All Cookies")',
      'button:has-text("Allow All")',
      'button:has-text("Godta alle")',
      'button:has-text("Aksepter alle")',
    ].join(", "));
    for (let i = 0; i < 5; i++) {
      try { await accept.first().waitFor({ timeout: 2000, state: "visible" }); await accept.first().click(); await page.waitForTimeout(600); } catch { break; }
    }

    await page.locator("#Username").fill(secrets.tripletex.username);
    await page.locator("#LoginButton").click();
    await page.locator('input[type="password"]').waitFor({ state: "visible", timeout: 10000 });
    await page.locator('input[type="password"]').fill(secrets.tripletex.password);
    await page.locator('button[type="submit"], #LoginButton').click();
    await page.waitForURL((url) => !url.toString().includes("login"), { timeout: 15000 });
    await page.waitForTimeout(2000);

    const csrfToken = await page.evaluate(() => localStorage.getItem("CSRFToken") ?? "");
    const contextId = new URL(page.url()).searchParams.get("contextId") ?? "";
    const cookies = await context.cookies("https://tripletex.no");
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Fetch the logged-in employee's ID so we can include it when posting timesheet entries
    const partialSession: Session = { cookieHeader, csrfToken, contextId, employeeId: "", expiresAt: Date.now() + SESSION_TTL_MS };
    const employeeId = await resolveEmployeeId(partialSession);
    console.log(`[Tripletex] Logged in. Employee ID: ${employeeId}`);

    const session: Session = { cookieHeader, csrfToken, contextId, employeeId, expiresAt: Date.now() + SESSION_TTL_MS };
    db.saveSession("tripletex", session);
    return session;
  } finally {
    // Browser only needed for login – close it immediately
    await browser.close();
  }
}

async function resolveEmployeeId(session: Session): Promise<string> {
  const headers = {
    "accept": "application/json; charset=utf-8",
    "cookie": session.cookieHeader,
    "x-tlx-csrf-token": session.csrfToken,
    "x-tlx-context-id": session.contextId,
  };
  // Try several endpoints until we get an integer employee ID
  const attempts = [
    "https://tripletex.no/v2/employee/~me?fields=id",
    "https://tripletex.no/v2/token/employee?fields=id",
  ];
  for (const url of attempts) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      const id = data.value?.id ?? data.value?.employee?.id;
      if (id) return String(id);
    } catch { /* try next */ }
  }
  // Last resort: grab from first timesheet entry
  try {
    const today = new Date().toISOString().split("T")[0]!;
    const from = today.substring(0, 7) + "-01";
    const res = await fetch(
      `https://tripletex.no/v2/timesheet/entry?dateFrom=${from}&dateTo=${today}&count=1&fields=employee(id)`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      const id = data.values?.[0]?.employee?.id;
      if (id) return String(id);
    }
  } catch { /* give up */ }
  throw new Error("Could not resolve Tripletex employee ID");
}

async function getSession(): Promise<Session> {
  // 1. In-memory (fastest)
  if (sharedSession && sharedSession.expiresAt > Date.now() && sharedSession.employeeId) return sharedSession;
  // 2. Persisted in DB (survives server restart)
  const persisted = db.loadSession("tripletex");
  if (persisted && persisted.employeeId) { sharedSession = persisted; return persisted; }
  // 3. Full login (slowest – opens browser)
  if (!loginPromise) {
    loginPromise = createSession().then((s) => {
      sharedSession = s;
      loginPromise = null;
      return s;
    }).catch((err) => { loginPromise = null; throw err; });
  }
  return loginPromise;
}

export class TripletexConnector implements IConnector {
  name = "tripletex";

  private async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = await getSession();
    try {
      return await fn(session);
    } catch (err: any) {
      if (err?.message?.includes("401") || err?.message?.includes("Unauthorized")) {
        sharedSession = null;
        db.saveSession("tripletex", { cookieHeader: "", csrfToken: "", contextId: "", employeeId: "", expiresAt: 0 });
        const fresh = await getSession();
        return fn(fresh);
      }
      throw err;
    }
  }

  private headers(session: Session, extra: Record<string, string> = {}): Record<string, string> {
    return {
      "accept": "application/json; charset=utf-8",
      "cookie": session.cookieHeader,
      "x-tlx-csrf-token": session.csrfToken,
      "x-tlx-context-id": session.contextId,
      ...extra,
    };
  }

  private async apiGet(session: Session, url: string): Promise<any> {
    const res = await fetch(url, { headers: this.headers(session) });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`Tripletex API error ${res.status}: ${body.substring(0, 200)}`);
    return JSON.parse(body);
  }

  private async apiPost(session: Session, url: string, body: any): Promise<any> {
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(session, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`Tripletex POST error ${res.status}: ${text.substring(0, 200)}`);
    return JSON.parse(text);
  }

  private async apiPut(session: Session, url: string, body: any): Promise<any> {
    const res = await fetch(url, {
      method: "PUT",
      headers: this.headers(session, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`Tripletex PUT error ${res.status}: ${text.substring(0, 200)}`);
    return JSON.parse(text);
  }

  private async apiDelete(session: Session, url: string): Promise<void> {
    await fetch(url, { method: "DELETE", headers: this.headers(session) });
  }

  async getProjects(): Promise<ConnectorProject[]> {
    return this.withSession(async (session) => {
      const data = await this.apiGet(session, "https://tripletex.no/v2/project?isClosedProject=false&count=1000&fields=id,displayName,customer");
      return (data.values ?? [])
        .filter((v: any) => v.displayName && v.customer?.id)
        .map((v: any) => ({ id: String(v.id), name: v.displayName }));
    });
  }

  async getActivities(projectId: number): Promise<ConnectorActivity[]> {
    return this.withSession(async (session) => {
      const data = await this.apiGet(session, `https://tripletex.no/v2/activity?projectId=${projectId}&isProjectActivity=true&count=1000&fields=id,displayName`);
      return (data.values ?? [])
        .filter((v: any) => v.displayName && !isAbsenceActivity(v.displayName))
        .map((v: any) => ({ id: String(v.id), name: v.displayName }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name, "nb"));
    });
  }

  async getAbsenceActivities(): Promise<ConnectorActivity[]> {
    return this.withSession(async (session) => {
      const data = await this.apiGet(session, `https://tripletex.no/v2/activity?isProjectActivity=false&count=1000&fields=id,displayName`);
      return (data.values ?? [])
        .filter((v: any) => v.displayName)
        .map((v: any) => ({ id: String(v.id), name: v.displayName }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name, "nb"));
    });
  }

  async getEntries(from: string, to: string): Promise<TimeEntry[]> {
    return this.withSession(async (session) => {
      const fields = "id,date,hours,project(id,displayName),activity(id,displayName),comment";
      const url = `https://tripletex.no/v2/timesheet/entry?dateFrom=${from}&dateTo=${to}&count=1000&fields=${encodeURIComponent(fields)}`;
      const data = await this.apiGet(session, url);
      return (data.values ?? []).filter((v: any) => v?.hours).map((v: any) => ({
        id: crypto.randomUUID(),
        date: v.date ?? "",
        hours: v.hours ?? 0,
        // For absence entries: project is null, use activityId as a synthetic projectId key
        projectId: v.project ? String(v.project.id) : (v.activity ? `absence:${v.activity.id}` : ""),
        description: v.comment ?? undefined,
        externalIds: { tripletex: String(v.id) },
      }));
    });
  }

  async pushEntry(entry: TimeEntry, mapping: ProjectMapping): Promise<string> {
    return this.withSession(async (session) => {
      if (!mapping.tripletex) throw new Error("No Tripletex mapping for project");
      const data = await this.apiPost(session, "https://tripletex.no/v2/timesheet/entry", {
        date: entry.date,
        hours: entry.hours,
        comment: entry.description ?? "",
        project: { id: mapping.tripletex.projectId },
        activity: { id: mapping.tripletex.activityId },
        employee: { id: Number(session.employeeId) },
      });
      return String(data.value?.id ?? "");
    });
  }

  async updateEntry(externalId: string, entry: TimeEntry, mapping: ProjectMapping): Promise<void> {
    await this.withSession(async (session) => {
      if (!mapping.tripletex) throw new Error("No Tripletex mapping for project");
      await this.apiPut(session, `https://tripletex.no/v2/timesheet/entry/${externalId}`, {
        date: entry.date,
        hours: entry.hours,
        comment: entry.description ?? "",
        project: { id: mapping.tripletex.projectId },
        activity: { id: mapping.tripletex.activityId },
        employee: { id: Number(session.employeeId) },
      });
    });
  }

  async deleteEntry(externalId: string): Promise<void> {
    await this.withSession(async (session) => {
      await this.apiDelete(session, `https://tripletex.no/v2/timesheet/entry/${externalId}`);
    });
  }
}

