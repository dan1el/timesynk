import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import type { Project, ProjectMapping, TimeEntry } from "../shared/types.js";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "timelog.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_mappings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    tripletex_project_id INTEGER,
    tripletex_project_name TEXT,
    tripletex_activity_id INTEGER,
    tripletex_activity_name TEXT,
    jira_project_key TEXT,
    jira_project_name TEXT,
    jira_issue_key TEXT
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    hours REAL NOT NULL,
    project_id TEXT REFERENCES projects(id),
    description TEXT,
    synced_at TEXT,
    external_tripletex_id TEXT,
    external_jira_id TEXT
  );

  CREATE TABLE IF NOT EXISTS connector_sessions (
    connector TEXT PRIMARY KEY,
    cookie_header TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    context_id TEXT NOT NULL,
    employee_id TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL
  );
`);

// Migrate: add employee_id column if it doesn't exist yet
try {
  db.exec("ALTER TABLE connector_sessions ADD COLUMN employee_id TEXT NOT NULL DEFAULT ''");
} catch { /* column already exists */ }

// Migrate: add sync_direction and is_absence columns to project_mappings
try {
  db.exec("ALTER TABLE project_mappings ADD COLUMN sync_direction TEXT NOT NULL DEFAULT 'both'");
} catch { /* already exists */ }
try {
  db.exec("ALTER TABLE project_mappings ADD COLUMN tripletex_is_absence INTEGER NOT NULL DEFAULT 0");
} catch { /* already exists */ }

export function getProjects(): Project[] {
  return (db.prepare("SELECT id, display_name FROM projects ORDER BY display_name").all() as any[])
    .map((r) => ({ id: r.id, displayName: r.display_name }));
}

export function upsertProject(project: Project): void {
  db.prepare("INSERT OR REPLACE INTO projects (id, display_name) VALUES (?, ?)").run(project.id, project.displayName);
}

export function deleteProject(id: string): void {
  db.prepare("DELETE FROM project_mappings WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function getProjectMappings(): ProjectMapping[] {
  return (db.prepare("SELECT * FROM project_mappings").all() as any[]).map(rowToMapping);
}

export function getProjectMapping(projectId: string): ProjectMapping | undefined {
  const row = db.prepare("SELECT * FROM project_mappings WHERE project_id = ?").get(projectId) as any;
  return row ? rowToMapping(row) : undefined;
}

function rowToMapping(r: any): ProjectMapping {
  const m: ProjectMapping = {
    projectId: r.project_id,
    syncDirection: (r.sync_direction ?? "both") as "both" | "tripletex_only",
  };
  if (r.tripletex_activity_id) {
    m.tripletex = {
      projectId: r.tripletex_project_id ?? null,
      projectName: r.tripletex_project_name ?? "",
      activityId: r.tripletex_activity_id,
      activityName: r.tripletex_activity_name,
      isAbsence: !!r.tripletex_is_absence,
    };
  }
  if (r.jira_project_key) {
    m.jira = {
      projectKey: r.jira_project_key,
      projectName: r.jira_project_name,
      issueKey: r.jira_issue_key ?? undefined,
    };
  }
  return m;
}

export function upsertProjectMapping(mapping: ProjectMapping): void {
  db.prepare(`
    INSERT OR REPLACE INTO project_mappings
      (project_id, sync_direction, tripletex_project_id, tripletex_project_name, tripletex_activity_id, tripletex_activity_name, tripletex_is_absence, jira_project_key, jira_project_name, jira_issue_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mapping.projectId,
    mapping.syncDirection ?? "both",
    mapping.tripletex?.projectId ?? null,
    mapping.tripletex?.projectName ?? null,
    mapping.tripletex?.activityId ?? null,
    mapping.tripletex?.activityName ?? null,
    mapping.tripletex?.isAbsence ? 1 : 0,
    mapping.jira?.projectKey ?? null,
    mapping.jira?.projectName ?? null,
    mapping.jira?.issueKey ?? null,
  );
}

export function getTimeEntries(from: string, to: string): TimeEntry[] {
  return (db.prepare("SELECT * FROM time_entries WHERE date >= ? AND date <= ? ORDER BY date DESC").all(from, to) as any[]).map(rowToEntry);
}

export function getTimeEntry(id: string): TimeEntry | undefined {
  const row = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id) as any;
  return row ? rowToEntry(row) : undefined;
}

export function getTimeEntriesWithTripletexId(from: string, to: string): TimeEntry[] {
  return (db.prepare(
    "SELECT * FROM time_entries WHERE date >= ? AND date <= ? AND external_tripletex_id IS NOT NULL AND external_tripletex_id != ''"
  ).all(from, to) as any[]).map(rowToEntry);
}

export function getTimeEntryByTripletexId(tripletexId: string): TimeEntry | undefined {
  const row = db.prepare("SELECT * FROM time_entries WHERE external_tripletex_id = ?").get(tripletexId) as any;
  return row ? rowToEntry(row) : undefined;
}

/** Find a local entry matching date+projectId+hours that has no Tripletex ID yet (for claim matching) */
export function getUnlinkedTripletexMatch(date: string, projectId: string, hours: number): TimeEntry | undefined {
  const row = db.prepare(
    "SELECT * FROM time_entries WHERE date = ? AND project_id = ? AND hours = ? AND (external_tripletex_id IS NULL OR external_tripletex_id = '') LIMIT 1"
  ).get(date, projectId, hours) as any;
  return row ? rowToEntry(row) : undefined;
}

/** Returns all distinct Jira issue keys ever stored in external_jira_id (format "ISSUE:id") */
export function getAllKnownJiraIssueKeys(): Set<string> {
  const rows = db.prepare(
    "SELECT DISTINCT external_jira_id FROM time_entries WHERE external_jira_id IS NOT NULL AND external_jira_id != ''"
  ).all() as any[];
  const keys = new Set<string>();
  for (const r of rows) {
    const issueKey = (r.external_jira_id as string).split(":")[0];
    if (issueKey) keys.add(issueKey);
  }
  return keys;
}

function rowToEntry(r: any): TimeEntry {
  return {
    id: r.id,
    date: r.date,
    hours: r.hours,
    projectId: r.project_id,
    description: r.description ?? undefined,
    syncedAt: r.synced_at ?? undefined,
    externalIds: {
      tripletex: r.external_tripletex_id ?? undefined,
      jira: r.external_jira_id ?? undefined,
    },
  };
}

export function upsertTimeEntry(entry: TimeEntry): void {
  db.prepare(`
    INSERT OR REPLACE INTO time_entries
      (id, date, hours, project_id, description, synced_at, external_tripletex_id, external_jira_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.date,
    entry.hours,
    entry.projectId,
    entry.description ?? null,
    entry.syncedAt ?? null,
    entry.externalIds.tripletex ?? null,
    entry.externalIds.jira ?? null,
  );
}

export function deleteTimeEntry(id: string): void {
  db.prepare("DELETE FROM time_entries WHERE id = ?").run(id);
}

// --- Connector sessions (persisted auth tokens) ---

export interface PersistedSession {
  cookieHeader: string;
  csrfToken: string;
  contextId: string;
  employeeId: string;
  expiresAt: number;
}

export function loadSession(connector: string): PersistedSession | null {
  const row = db.prepare("SELECT * FROM connector_sessions WHERE connector = ?").get(connector) as any;
  if (!row || row.expires_at <= Date.now()) return null;
  return { cookieHeader: row.cookie_header, csrfToken: row.csrf_token, contextId: row.context_id, employeeId: row.employee_id ?? "", expiresAt: row.expires_at };
}

export function saveSession(connector: string, session: PersistedSession): void {
  db.prepare(`
    INSERT OR REPLACE INTO connector_sessions (connector, cookie_header, csrf_token, context_id, employee_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(connector, session.cookieHeader, session.csrfToken, session.contextId, session.employeeId ?? "", session.expiresAt);
}

