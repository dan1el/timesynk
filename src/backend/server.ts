import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import * as db from "./db.js";
import { TripletexConnector } from "./connectors/tripletex.js";
import { JiraConnector } from "./connectors/jira.js";
import type { ProjectMapping, TimeEntry } from "../shared/types.js";

const app = express();
app.use(cors());
app.use(express.json());

// Warm up Tripletex session at startup (non-blocking)
// This runs login in the background so it's ready when the user opens the UI.
const tripletex = new TripletexConnector();
const jira = new JiraConnector();
tripletex.getProjects().catch(() => {}); // triggers getSession() → login or DB restore

// --- Simple in-memory cache for slow connector calls (Tripletex requires a browser) ---
interface CacheEntry<T> { data: T; expiresAt: number; }
const cache = new Map<string, CacheEntry<unknown>>();
function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  return fn().then((data) => {
    cache.set(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  });
}

// --- Projects ---

app.get("/api/projects", (_req, res) => {
  const projects = db.getProjects();
  const mappings = db.getProjectMappings();
  const mappingMap = new Map(mappings.map((m) => [m.projectId, m]));
  res.json(projects.map((p) => ({ ...p, mapping: mappingMap.get(p.id) ?? null })));
});

app.post("/api/projects", (req, res) => {
  const { displayName } = req.body as { displayName: string };
  if (!displayName) { res.status(400).json({ error: "displayName required" }); return; }
  const id = randomUUID();
  db.upsertProject({ id, displayName });
  res.status(201).json({ id, displayName });
});

app.put("/api/projects/:id", (req, res) => {
  const { displayName } = req.body as { displayName: string };
  db.upsertProject({ id: req.params.id, displayName });
  res.json({ id: req.params.id, displayName });
});

app.delete("/api/projects/:id", (req, res) => {
  db.deleteProject(req.params.id);
  res.status(204).end();
});

// --- Project Mappings ---

app.get("/api/projects/:id/mapping", (req, res) => {
  const mapping = db.getProjectMapping(req.params.id);
  res.json(mapping ?? null);
});

app.put("/api/projects/:id/mapping", (req, res) => {
  const mapping: ProjectMapping = { ...req.body, projectId: req.params.id };
  db.upsertProjectMapping(mapping);
  res.json(mapping);
});

// --- Connectors (live data) ---

app.get("/api/connectors/tripletex/projects", async (_req, res) => {
  try {
    const projects = await cached("tt-projects", 5 * 60_000, () => tripletex.getProjects());
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/connectors/tripletex/activities/:projectId", async (req, res) => {
  try {
    const key = `tt-activities-${req.params.projectId}`;
    const activities = await cached(key, 5 * 60_000, () => tripletex.getActivities(Number(req.params.projectId)));
    res.json(activities);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/connectors/jira/projects", async (_req, res) => {
  try {
    const projects = await cached("jira-projects", 5 * 60_000, () => jira.getProjects());
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/connectors/jira/issues/:projectKey", async (req, res) => {
  try {
    const key = `jira-issues-${req.params.projectKey}`;
    const issues = await cached(key, 5 * 60_000, () => (jira as any).getIssues(req.params.projectKey));
    res.json(issues);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Time Entries ---

app.get("/api/entries", (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) { res.status(400).json({ error: "from and to required" }); return; }
  res.json(db.getTimeEntries(from, to));
});

app.post("/api/entries", (req, res) => {
  const { date, hours, projectId, description } = req.body;
  if (!date || !hours || !projectId) { res.status(400).json({ error: "date, hours, projectId required" }); return; }
  const entry = { id: randomUUID(), date, hours, projectId, description, externalIds: {} };
  db.upsertTimeEntry(entry);
  res.status(201).json(entry);
});

app.put("/api/entries/:id", (req, res) => {
  const existing = db.getTimeEntry(req.params.id);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const updated = { ...existing, ...req.body, id: req.params.id };
  db.upsertTimeEntry(updated);
  res.json(updated);
});

app.delete("/api/entries/:id", async (req, res) => {
  const entry = db.getTimeEntry(req.params.id);
  if (!entry) { res.status(404).end(); return; }

  const errors: string[] = [];

  // Delete from connectors first (best-effort)
  if (entry.externalIds.tripletex) {
    try { await tripletex.deleteEntry(entry.externalIds.tripletex); }
    catch (err: any) { errors.push(`Tripletex: ${err.message}`); }
  }
  if (entry.externalIds.jira) {
    try { await jira.deleteEntry(entry.externalIds.jira); }
    catch (err: any) { errors.push(`Jira: ${err.message}`); }
  }

  db.deleteTimeEntry(req.params.id);

  if (errors.length > 0) {
    res.status(207).json({ deleted: true, warnings: errors });
  } else {
    res.status(204).end();
  }
});

// --- Sync ---

/** Tripletex dateTo is exclusive – advance by one day to include the last date */
function ttxToExclusive(date: string): string {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0]!;
}

app.get("/api/sync/preview", async (req, res) => {
  try {
    const now = new Date().toISOString().split("T").at(0)!;
    const from = (req.query.from as string) || now.substring(0, 7) + "-01";
    const to = (req.query.to as string) || now;
    const localEntries = db.getTimeEntries(from, to);
    const mappings = db.getProjectMappings();
    const mappingMap = new Map(mappings.map((m) => [m.projectId, m]));
    const projects = db.getProjects();
    const projectMap = new Map(projects.map((p) => [p.id, p.displayName]));

    const toUpsert: any[] = [];
    const toDelete: any[] = [];

    const jiraIssueKeys = new Set<string>();
    const tripletexProjectIds = new Set<number>();
    for (const m of mappings) {
      if (m.jira?.issueKey) jiraIssueKeys.add(m.jira.issueKey);
      else if (m.jira?.projectKey) jiraIssueKeys.add(m.jira.projectKey);
      if (m.tripletex?.projectId) tripletexProjectIds.add(m.tripletex.projectId);
    }
    for (const key of db.getAllKnownJiraIssueKeys()) jiraIssueKeys.add(key);

    const localJiraIds = new Set(localEntries.map((e) => e.externalIds.jira).filter(Boolean) as string[]);
    const localTripletexIds = new Set(localEntries.map((e) => e.externalIds.tripletex).filter(Boolean) as string[]);
    // Maps for quick lookup of local entry by external ID (for update detection)
    const localEntryByJiraId = new Map(localEntries.filter(e => e.externalIds.jira).map(e => [e.externalIds.jira!, e]));
    const localEntryByTtxId = new Map(localEntries.filter(e => e.externalIds.tripletex).map(e => [e.externalIds.tripletex!, e]));

    // Build lookup: unlinked local entries by "issueKey:date:hours" for claim matching
    const unlinkedJiraByKey = new Map<string, { entry: typeof localEntries[0]; name: string }>();
    for (const entry of localEntries) {
      if (entry.externalIds.jira) continue;
      const mapping = mappingMap.get(entry.projectId);
      if (!mapping?.jira) continue;
      const issueKey = mapping.jira.issueKey ?? mapping.jira.projectKey!;
      const key = `${issueKey}:${entry.date}:${entry.hours}`;
      if (!unlinkedJiraByKey.has(key)) {
        unlinkedJiraByKey.set(key, { entry, name: projectMap.get(entry.projectId) ?? entry.projectId });
      }
    }
    console.log("[preview] unlinkedJiraByKey keys:", [...unlinkedJiraByKey.keys()]);
    console.log("[preview] jiraIssueKeys:", [...jiraIssueKeys]);

    const claimedEntryIds = new Set<string>();

    // Jira: fetch worklogs, detect creates/updates/claims/orphans
    for (const issueKey of jiraIssueKeys) {
      try {
        const worklogs = await jira.getWorklogs(issueKey, from, to);
        for (const w of worklogs) {
          const compositeId = `${issueKey}:${w.id}`;
          const linkedEntry = localEntryByJiraId.get(compositeId);
          if (linkedEntry) {
            // Known entry – check if hours changed
            if (linkedEntry.hours !== w.hours) {
              const name = projectMap.get(linkedEntry.projectId) ?? linkedEntry.projectId;
              toUpsert.push({ id: linkedEntry.id, date: linkedEntry.date, hours: linkedEntry.hours, projectName: name, connector: "jira", action: "update" });
            }
            continue;
          }
          const claimKey = `${issueKey}:${w.date}:${w.hours}`;
          console.log(`[preview] claimKey attempt: "${claimKey}", match: ${unlinkedJiraByKey.has(claimKey)}`);
          const match = unlinkedJiraByKey.get(claimKey);
          if (match) {
            claimedEntryIds.add(match.entry.id);
          } else {
            const name = mappings.find(m => (m.jira?.issueKey ?? m.jira?.projectKey) === issueKey)
              ? projectMap.get(mappings.find(m => (m.jira?.issueKey ?? m.jira?.projectKey) === issueKey)!.projectId) ?? issueKey
              : issueKey;
            toDelete.push({ connector: "jira", ref: name, worklogId: w.id, date: w.date, hours: w.hours });
          }
        }
      } catch (err: any) { console.warn(`[preview] getWorklogs(${issueKey}) failed:`, err?.message ?? err); }
    }

    // Build upserts for entries not yet linked or claimed
    for (const entry of localEntries) {
      const mapping = mappingMap.get(entry.projectId);
      if (!mapping) continue;
      const name = projectMap.get(entry.projectId) ?? entry.projectId;
      if (mapping.jira && !entry.externalIds.jira && !claimedEntryIds.has(entry.id)) {
        toUpsert.push({ id: entry.id, date: entry.date, hours: entry.hours, projectName: name, connector: "jira", action: "create" });
      }
      if (mapping.tripletex && !entry.externalIds.tripletex) {
        toUpsert.push({ id: entry.id, date: entry.date, hours: entry.hours, projectName: name, connector: "tripletex", action: "create" });
      }
    }

    // Tripletex: detect orphans, updates, and stale IDs
    if (tripletexProjectIds.size > 0) {
      try {
        const remoteEntries = await tripletex.getEntries(from, ttxToExclusive(to));
        const remoteTtxIds = new Set(remoteEntries.map(e => e.externalIds.tripletex).filter(Boolean) as string[]);

        // Local entries with Tripletex ID that no longer exists remotely → re-create
        for (const entry of localEntries) {
          if (!entry.externalIds.tripletex) continue;
          if (!remoteTtxIds.has(entry.externalIds.tripletex)) {
            const mapping = mappingMap.get(entry.projectId);
            if (!mapping?.tripletex) continue;
            const name = projectMap.get(entry.projectId) ?? entry.projectId;
            toUpsert.push({ id: entry.id, date: entry.date, hours: entry.hours, projectName: name, connector: "tripletex", action: "create" });
          }
        }

        for (const re of remoteEntries) {
          const ttxId = re.externalIds.tripletex!;
          if (!ttxId) continue;
          const linkedEntry = localEntryByTtxId.get(ttxId);
          if (linkedEntry) {
            if (linkedEntry.hours !== re.hours) {
              const name = projectMap.get(linkedEntry.projectId) ?? linkedEntry.projectId;
              toUpsert.push({ id: linkedEntry.id, date: linkedEntry.date, hours: linkedEntry.hours, projectName: name, connector: "tripletex", action: "update" });
            }
          } else {
            const mapping = mappings.find(m => m.tripletex && String(m.tripletex.projectId) === re.projectId);
            const projectName = mapping ? (projectMap.get(mapping.projectId) ?? mapping.tripletex!.projectName) : re.projectId;
            toDelete.push({ connector: "tripletex", tripletexId: ttxId, date: re.date, hours: re.hours, ref: projectName });
          }
        }
      } catch (err: any) { console.warn(`[preview] tripletex.getEntries failed:`, err?.message ?? err); }
    }

    res.json({ toUpsert: toUpsert.sort((a, b) => a.date.localeCompare(b.date)), toDelete: toDelete.sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sync/push", async (req, res) => {
  try {
    const now = new Date().toISOString().split("T").at(0)!;
    const from = (req.query.from as string) || now.substring(0, 7) + "-01";
    const to = (req.query.to as string) || now;
    const localEntries = db.getTimeEntries(from, to);
    const mappings = db.getProjectMappings();
    const mappingMap = new Map(mappings.map((m) => [m.projectId, m]));

    const results: any[] = [];

    // Build lookup: unlinked local entries by "issueKey:date:hours" for claim matching
    const unlinkedJiraByKey = new Map<string, typeof localEntries[0]>();
    for (const entry of localEntries) {
      if (entry.externalIds.jira) continue;
      const mapping = mappingMap.get(entry.projectId);
      if (!mapping?.jira) continue;
      const issueKey = mapping.jira.issueKey ?? mapping.jira.projectKey!;
      const key = `${issueKey}:${entry.date}:${entry.hours}`;
      if (!unlinkedJiraByKey.has(key)) unlinkedJiraByKey.set(key, entry);
    }

    // Fetch remote Jira worklogs first so we can claim matches before pushing
    const jiraIssueKeys = new Set<string>();
    for (const m of mappings) {
      if (m.jira?.issueKey) jiraIssueKeys.add(m.jira.issueKey);
      else if (m.jira?.projectKey) jiraIssueKeys.add(m.jira.projectKey);
    }
    for (const key of db.getAllKnownJiraIssueKeys()) jiraIssueKeys.add(key);

    const claimedEntryIds = new Set<string>();
    const orphanWorklogs: { issueKey: string; id: string; date: string; hours: number }[] = [];

    for (const issueKey of jiraIssueKeys) {
      try {
        const worklogs = await jira.getWorklogs(issueKey, from, to);
        for (const w of worklogs) {
          const compositeId = `${issueKey}:${w.id}`;
          // Re-fetch updated localJiraIds after each claim
          const currentJiraIds = new Set(db.getTimeEntries(from, to).map((e) => e.externalIds.jira).filter(Boolean) as string[]);
          if (currentJiraIds.has(compositeId)) continue;
          const claimKey = `${issueKey}:${w.date}:${w.hours}`;
          const match = unlinkedJiraByKey.get(claimKey);
          if (match && !claimedEntryIds.has(match.id)) {
            // Claim: link this worklog to the local entry without creating a new one
            claimedEntryIds.add(match.id);
            db.upsertTimeEntry({ ...match, externalIds: { ...match.externalIds, jira: compositeId } });
            // Don't add to results – claiming is silent background linking
          } else {
            orphanWorklogs.push({ issueKey, id: w.id, date: w.date, hours: w.hours });
          }
        }
      } catch (err: any) { console.warn(`[push] getWorklogs(${issueKey}) failed:`, err?.message ?? err); }
    }

    // Re-read entries after claims
    const updatedEntries = db.getTimeEntries(from, to);

    // Fetch remote Tripletex entries once to detect stale IDs and orphans
    const remoteTtxEntries = await tripletex.getEntries(from, ttxToExclusive(to)).catch(() => [] as typeof updatedEntries);
    const remoteTtxIds = new Set(remoteTtxEntries.map(e => e.externalIds.tripletex).filter(Boolean) as string[]);

    // 1. Upsert local entries to connectors (create missing, re-create stale, update unconfirmed)
    for (const entry of updatedEntries) {
      const mapping = mappingMap.get(entry.projectId);
      if (!mapping) continue;
      const result: any = { id: entry.id, date: entry.date, hours: entry.hours, tripletex: null, jira: null, error: null };
      try {
        if (mapping.tripletex) {
          if (!entry.externalIds.tripletex || !remoteTtxIds.has(entry.externalIds.tripletex)) {
            // No ID, or ID exists locally but was deleted remotely → re-create
            result.tripletex = await tripletex.pushEntry(entry, mapping);
          } else if (!entry.syncedAt) {
            // Pulled/claimed entry: ensure Tripletex has current hours
            await tripletex.updateEntry(entry.externalIds.tripletex, entry, mapping);
            result.tripletex = entry.externalIds.tripletex;
          }
        }
        if (mapping.jira && !entry.externalIds.jira) {
          const worklogId = await jira.pushEntry(entry, mapping);
          result.jira = `${mapping.jira.issueKey ?? mapping.jira.projectKey}:${worklogId}`;
        }
        if (result.tripletex || result.jira) {
          db.upsertTimeEntry({
            ...entry,
            syncedAt: new Date().toISOString(),
            externalIds: {
              tripletex: result.tripletex ?? entry.externalIds.tripletex,
              jira: result.jira ?? entry.externalIds.jira,
            },
          });
        }
      } catch (err: any) {
        result.error = err.message;
      }
      if (result.tripletex || result.jira || result.error) results.push(result);
    }

    // Re-read IDs from DB after all pushes so orphan cleanup has current state
    const freshEntries = db.getTimeEntries(from, to);
    const freshTripletexIds = new Set(freshEntries.map((e) => e.externalIds.tripletex).filter(Boolean) as string[]);
    const freshJiraIds = new Set(freshEntries.map((e) => e.externalIds.jira).filter(Boolean) as string[]);

    // 2. Delete orphaned remote Jira worklogs
    for (const w of orphanWorklogs) {
      if (freshJiraIds.has(`${w.issueKey}:${w.id}`)) continue;
      try {
        await jira.deleteWorklog(w.issueKey, w.id);
        results.push({ date: w.date, hours: w.hours, jira: `deleted:${w.issueKey}:${w.id}`, tripletex: null, error: null });
      } catch (err: any) {
        results.push({ date: w.date, hours: w.hours, jira: null, tripletex: null, error: `Jira delete: ${err.message}` });
      }
    }

    const remoteEntries = await tripletex.getEntries(from, ttxToExclusive(to)).catch(() => []);
    for (const re of remoteEntries) {
      if (re.externalIds.tripletex && !freshTripletexIds.has(re.externalIds.tripletex)) {
        try {
          await tripletex.deleteEntry(re.externalIds.tripletex);
          results.push({ date: re.date, hours: re.hours, tripletex: `deleted:${re.externalIds.tripletex}`, jira: null, error: null });
        } catch (err: any) {
          results.push({ date: re.date, hours: re.hours, tripletex: null, jira: null, error: `Tripletex delete: ${err.message}` });
        }
      }
    }

    res.json({ synced: results.length, results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sync/pull", async (req, res) => {
  try {
    const now = new Date().toISOString().split("T").at(0)!;
    const month: string = (req.query.month as string) || now.substring(0, 7);
    const from = `${month}-01`;
    const [yr, mo] = month.split("-").map(Number) as [number, number];
    const lastDay = new Date(yr, mo, 0).getDate();
    const to = `${month}-${String(lastDay).padStart(2, "0")}`;
    // Tripletex dateTo is exclusive – pass first day of next month to include last day
    const toExclusive = mo === 12 ? `${yr + 1}-01-01` : `${yr}-${String(mo + 1).padStart(2, "0")}-01`;
    const mappings = db.getProjectMappings();
    const reverseMap = new Map<number, string>();
    for (const m of mappings) {
      if (m.tripletex?.projectId) reverseMap.set(m.tripletex.projectId, m.projectId);
    }

    const entries = await tripletex.getEntries(from, toExclusive);
    console.log(`[pull] ${month}: getEntries(${from}, ${toExclusive}) returned ${entries.length} entries. lastDay=${lastDay}`);
    let pulled = 0;
    let skipped = 0;

    for (const entry of entries) {
      const localProjectId = reverseMap.get(Number(entry.projectId));
      if (!localProjectId) {
        console.log(`[pull] skipped entry ${entry.date} ${entry.hours}t projectId=${entry.projectId} (no mapping)`);
        skipped++; continue;
      }

      const tripletexId = entry.externalIds.tripletex!;
      const existing = db.getTimeEntryByTripletexId(tripletexId);
      if (!existing) {
        db.upsertTimeEntry({ ...entry, projectId: localProjectId });
        console.log(`[pull] imported ${entry.date} ${entry.hours}t projectId=${localProjectId} ttxId=${tripletexId}`);
        pulled++;
      } else {
        console.log(`[pull] already exists ${entry.date} ${entry.hours}t ttxId=${tripletexId}`);
      }
    }

    res.json({ pulled, skipped, month });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
