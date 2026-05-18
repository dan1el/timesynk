import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface Project { id: string; displayName: string; mapping?: any; }
interface ConnectorProject { id: string; name: string; }
interface ConnectorActivity { id: string; name: string; }

async function fetchJSON(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

export function Settings() {
  const qc = useQueryClient();
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [newName, setNewName] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => fetchJSON("/api/projects"),
  });

  const addMutation = useMutation({
    mutationFn: (displayName: string) => fetchJSON("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projects"] }); setShowAdd(false); setNewName(""); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetchJSON(`/api/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Prosjekter og koblinger</h1>
        <button onClick={() => setShowAdd(true)} style={btnStyle}>+ Legg til prosjekt</button>
      </div>

      {showAdd && (
        <div style={{ padding: 16, background: "var(--surface)", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 16, display: "flex", gap: 8 }}>
          <input autoFocus placeholder="Prosjektnavn" value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addMutation.mutate(newName)}
            style={{ ...inputStyle, flex: 1 }} />
          <button onClick={() => addMutation.mutate(newName)} style={{ ...btnStyle, background: "var(--accent)", color: "var(--nav-text)" }}>Legg til</button>
          <button onClick={() => setShowAdd(false)} style={btnStyle}>Avbryt</button>
        </div>
      )}

      {projects.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>Ingen prosjekter ennå. Legg til et for å komme i gang.</p>
      ) : (
        projects.map((p) => (
          <div key={p.id} style={{ padding: "14px 16px", background: "var(--surface)", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 10, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{p.displayName}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                {p.mapping?.syncDirection === "tripletex_only" && (
                  <span style={badgeStyle("#fef3c7", "#92400e")}>Kun Tripletex</span>
                )}
                {p.mapping?.tripletex && (
                  <span style={badgeStyle("#dbeafe", "#1e40af")}>
                    {p.mapping.tripletex.isAbsence ? "Fravær: " : "Tripletex: "}
                    {p.mapping.tripletex.isAbsence ? p.mapping.tripletex.activityName : `${p.mapping.tripletex.projectName} → ${p.mapping.tripletex.activityName}`}
                  </span>
                )}
                {p.mapping?.jira && p.mapping?.syncDirection !== "tripletex_only" && (
                  <span style={badgeStyle("#dcfce7", "#166534")}>
                    Jira: {p.mapping.jira.projectKey}{p.mapping.jira.issueKey ? ` #${p.mapping.jira.issueKey}` : ""}
                  </span>
                )}
                {!p.mapping?.tripletex && !p.mapping?.jira && (
                  <span style={badgeStyle("#f3f4f6", "var(--text-muted)")}>Ingen kobling</span>
                )}
              </div>
            </div>
            <button onClick={() => setEditProject(p)} style={btnStyle}>Konfigurer</button>
            <button onClick={() => deleteMutation.mutate(p.id)} style={{ ...btnStyle, color: "var(--red)", borderColor: "var(--red)" }}>Slett</button>
          </div>
        ))
      )}

      {editProject && (
        <ProjectMappingModal
          project={editProject}
          onClose={() => setEditProject(null)}
          onSaved={() => { setEditProject(null); qc.invalidateQueries({ queryKey: ["projects"] }); }}
        />
      )}
    </div>
  );
}

function ProjectMappingModal({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void; }) {
  const existing = project.mapping;
  const [displayName, setDisplayName] = useState(project.displayName);
  const [syncDirection, setSyncDirection] = useState<"both" | "tripletex_only">(existing?.syncDirection ?? "both");
  const [isAbsence, setIsAbsence] = useState<boolean>(existing?.tripletex?.isAbsence ?? false);
  const [ttProjectId, setTtProjectId] = useState(String(existing?.tripletex?.projectId ?? ""));
  const [ttProjectName, setTtProjectName] = useState(existing?.tripletex?.projectName ?? "");
  const [ttActivityId, setTtActivityId] = useState(String(existing?.tripletex?.activityId ?? ""));
  const [ttActivityName, setTtActivityName] = useState(existing?.tripletex?.activityName ?? "");
  const [jiraProjectKey, setJiraProjectKey] = useState(existing?.jira?.projectKey ?? "");
  const [jiraProjectName, setJiraProjectName] = useState(existing?.jira?.projectName ?? "");
  const [jiraIssueKey, setJiraIssueKey] = useState(existing?.jira?.issueKey ?? "");
  const [activitySearch, setActivitySearch] = useState("");
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  const { data: ttProjects = [], isLoading: loadingTt, isError: ttError } = useQuery<ConnectorProject[]>({
    queryKey: ["tt-projects"],
    queryFn: () => fetchJSON("/api/connectors/tripletex/projects"),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const { data: ttActivities = [], isLoading: loadingAct, isError: actError } = useQuery<ConnectorActivity[]>({
    queryKey: ["tt-activities", ttProjectId],
    queryFn: () => fetchJSON(`/api/connectors/tripletex/activities/${ttProjectId}`),
    enabled: !!ttProjectId && !isAbsence,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const { data: absenceActivities = [], isLoading: loadingAbsence } = useQuery<ConnectorActivity[]>({
    queryKey: ["tt-absence-activities"],
    queryFn: () => fetchJSON("/api/connectors/tripletex/activities/absence"),
    enabled: isAbsence,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const { data: jiraProjects = [], isLoading: loadingJira, isError: jiraError } = useQuery<ConnectorProject[]>({
    queryKey: ["jira-projects"],
    queryFn: () => fetchJSON("/api/connectors/jira/projects"),
    retry: false,
    staleTime: 5 * 60_000,
    enabled: syncDirection === "both",
  });

  const { data: jiraIssues = [], isLoading: loadingIssues } = useQuery<Array<{ key: string; summary: string }>>({
    queryKey: ["jira-issues", jiraProjectKey],
    queryFn: () => fetchJSON(`/api/connectors/jira/issues/${jiraProjectKey}`),
    enabled: !!jiraProjectKey && syncDirection === "both",
    retry: false,
    staleTime: 5 * 60_000,
  });

  async function save() {
    setSaving(true);
    try {
      await fetchJSON(`/api/projects/${project.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName }) });
      const mapping: any = { projectId: project.id, syncDirection };
      if (ttActivityId) {
        mapping.tripletex = {
          projectId: isAbsence ? null : (ttProjectId ? parseInt(ttProjectId) : null),
          projectName: isAbsence ? "" : ttProjectName,
          activityId: parseInt(ttActivityId),
          activityName: ttActivityName,
          isAbsence,
        };
      }
      if (syncDirection === "both" && jiraProjectKey) {
        mapping.jira = { projectKey: jiraProjectKey, projectName: jiraProjectName, issueKey: jiraIssueKey || undefined };
      }
      await fetchJSON(`/api/projects/${project.id}/mapping`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mapping) });
      qc.invalidateQueries({ queryKey: ["projects"] });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const displayActivities = isAbsence ? absenceActivities : ttActivities;
  const loadingActivities = isAbsence ? loadingAbsence : loadingAct;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, overflowY: "auto" }}>
      <div style={{ background: "var(--surface)", borderRadius: 12, padding: 28, minWidth: 420, maxWidth: 520, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", margin: "40px auto" }}>
        <h2 style={{ marginBottom: 20, fontSize: 18 }}>Konfigurer prosjekt</h2>

        <label style={labelStyle}>Visningsnavn</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} />

        {/* Sync direction toggle */}
        <label style={labelStyle}>Synkroniseringsretning</label>
        <div style={{ display: "flex", borderRadius: 6, border: "1px solid var(--border)", overflow: "hidden", marginBottom: 4 }}>
          <button
            type="button"
            onClick={() => setSyncDirection("both")}
            style={{ flex: 1, padding: "8px", border: "none", fontSize: 13, cursor: "pointer", background: syncDirection === "both" ? "var(--accent)" : "var(--btn-bg)", color: syncDirection === "both" ? "#fff" : "var(--text-secondary)" }}
          >
            ⇅ Jira og Tripletex
          </button>
          <button
            type="button"
            onClick={() => setSyncDirection("tripletex_only")}
            style={{ flex: 1, padding: "8px", border: "none", borderLeft: "1px solid var(--border)", fontSize: 13, cursor: "pointer", background: syncDirection === "tripletex_only" ? "#f59e0b" : "var(--btn-bg)", color: syncDirection === "tripletex_only" ? "#fff" : "var(--text-secondary)" }}
          >
            → Kun Tripletex
          </button>
        </div>
        {syncDirection === "tripletex_only" && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}>
            Timer registreres kun i Tripletex (ferie, sykdom, fravær). Ingen Jira-sync.
          </p>
        )}

        <div style={{ margin: "20px 0 8px", fontWeight: 600, fontSize: 15, color: "var(--accent)" }}>Tripletex</div>

        {/* Absence toggle */}
        <label style={labelStyle}>Type</label>
        <div style={{ display: "flex", borderRadius: 6, border: "1px solid var(--border)", overflow: "hidden", marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => { setIsAbsence(false); setTtActivityId(""); setTtActivityName(""); }}
            style={{ flex: 1, padding: "7px", border: "none", fontSize: 13, cursor: "pointer", background: !isAbsence ? "var(--accent)" : "var(--btn-bg)", color: !isAbsence ? "#fff" : "var(--text-secondary)" }}
          >
            Prosjektaktivitet
          </button>
          <button
            type="button"
            onClick={() => { setIsAbsence(true); setTtProjectId(""); setTtProjectName(""); setTtActivityId(""); setTtActivityName(""); }}
            style={{ flex: 1, padding: "7px", border: "none", borderLeft: "1px solid var(--border)", fontSize: 13, cursor: "pointer", background: isAbsence ? "var(--accent)" : "var(--btn-bg)", color: isAbsence ? "#fff" : "var(--text-secondary)" }}
          >
            Fravær / intern aktivitet
          </button>
        </div>

        {!isAbsence && (
          <>
            <label style={labelStyle}>Prosjekt</label>
            {loadingTt ? (
              <div style={{ ...inputStyle, color: "var(--text-muted)", background: "var(--bg-subtle)" }}>
                ⏳ Logger inn i Tripletex… (kan ta 5–10 sek)
              </div>
            ) : ttError ? (
              <div style={{ padding: "8px 10px", background: "#fee2e2", borderRadius: 6, fontSize: 13, color: "#dc2626", marginBottom: 4 }}>
                Klarte ikke hente Tripletex-prosjekter. Sjekk secrets.json.
              </div>
            ) : ttProjects.length > 0 ? (
              <select value={ttProjectId} onChange={(e) => {
                const p = ttProjects.find((p) => p.id === e.target.value);
                setTtProjectId(e.target.value);
                setTtProjectName(p?.name ?? "");
                setTtActivityId(""); setTtActivityName(""); setActivitySearch("");
              }} style={inputStyle}>
                <option value="">— Ingen —</option>
                {ttProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : null}
          </>
        )}

        {(isAbsence || ttProjectId) && (
          <>
            <label style={labelStyle}>{isAbsence ? "Fraværstype" : "Aktivitet"}</label>
            {loadingActivities ? (
              <div style={{ ...inputStyle, color: "var(--text-muted)", background: "var(--bg-subtle)" }}>⏳ Henter aktiviteter…</div>
            ) : actError && !isAbsence ? (
              <div style={{ padding: "8px 10px", background: "#fee2e2", borderRadius: 6, fontSize: 13, color: "#dc2626" }}>
                Klarte ikke hente aktiviteter.
              </div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="Søk…"
                  value={activitySearch}
                  onChange={(e) => setActivitySearch(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 4 }}
                />
                <select value={ttActivityId} onChange={(e) => {
                  const a = displayActivities.find((a) => a.id === e.target.value);
                  setTtActivityId(e.target.value);
                  setTtActivityName(a?.name ?? "");
                }} style={{ ...inputStyle, height: 140 }} size={6}>
                  <option value="">— Ingen —</option>
                  {displayActivities
                    .filter((a) => !activitySearch || a.name.toLowerCase().includes(activitySearch.toLowerCase()))
                    .map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </>
            )}
          </>
        )}

        {syncDirection === "both" && (
          <>
            <div style={{ margin: "20px 0 8px", fontWeight: 600, fontSize: 15, color: "#059669" }}>Jira</div>
            <label style={labelStyle}>Prosjekt</label>
            {loadingJira ? (
              <div style={{ ...inputStyle, color: "var(--text-muted)", background: "var(--bg-subtle)" }}>⏳ Henter Jira-prosjekter…</div>
            ) : jiraError ? (
              <div style={{ padding: "8px 10px", background: "#fee2e2", borderRadius: 6, fontSize: 13, color: "#dc2626", marginBottom: 4 }}>
                Klarte ikke hente Jira-prosjekter. Sjekk jira-secrets i secrets.json.
              </div>
            ) : jiraProjects.length > 0 ? (
              <select value={jiraProjectKey} onChange={(e) => {
                const p = jiraProjects.find((p) => p.id === e.target.value);
                setJiraProjectKey(e.target.value);
                setJiraProjectName(p?.name ?? "");
                setJiraIssueKey("");
              }} style={inputStyle}>
                <option value="">— Ingen —</option>
                {jiraProjects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
              </select>
            ) : null}

            {jiraProjectKey && (
              <>
                <label style={labelStyle}>Sak (Issue)</label>
                {loadingIssues ? (
                  <div style={{ ...inputStyle, color: "var(--text-muted)", background: "var(--bg-subtle)" }}>⏳ Henter issues…</div>
                ) : (
                  <select value={jiraIssueKey} onChange={(e) => setJiraIssueKey(e.target.value)} style={inputStyle}>
                    <option value="">— Ingen (logg på prosjektnivå) —</option>
                    {jiraIssues.map((i) => (
                      <option key={i.key} value={i.key}>{i.key}: {i.summary}</option>
                    ))}
                  </select>
                )}
              </>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
          <button onClick={save} disabled={saving} style={{ ...btnStyle, background: "var(--accent)", color: "var(--nav-text)", flex: 1 }}>
            {saving ? "Lagrer…" : "Lagre"}
          </button>
          <button onClick={onClose} style={{ ...btnStyle, flex: 1 }}>Avbryt</button>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = { padding: "6px 14px", border: "1px solid var(--btn-border)", borderRadius: 6, background: "var(--btn-bg)", fontSize: 14, cursor: "pointer" };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4, marginTop: 12 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid var(--input-border)", borderRadius: 6, fontSize: 14, background: "var(--input-bg)", color: "var(--text-primary)", boxSizing: "border-box" };
function badgeStyle(bg: string, color: string): React.CSSProperties {
  return { background: bg, color, padding: "2px 8px", borderRadius: 12, fontSize: 12, fontWeight: 500 };
}
