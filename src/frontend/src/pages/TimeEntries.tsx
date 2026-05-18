import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, startOfMonth, startOfWeek, endOfWeek, addWeeks, subWeeks, addMonths, subMonths, eachDayOfInterval, endOfMonth, parseISO } from "date-fns";
import { nb } from "date-fns/locale";
import { MonthView } from "./MonthView";

interface Project { id: string; displayName: string; }
interface TimeEntry {
  id: string; date: string; hours: number; projectId: string;
  description?: string; syncedAt?: string; externalIds: { tripletex?: string; jira?: string; };
}
interface PreviewUpsert {
  id: string; date: string; hours: number; projectName: string;
  connector: "jira" | "tripletex"; action: "create"; ref: string;
}
interface PreviewDelete {
  connector: "jira" | "tripletex"; date: string; hours: number;
  ref?: string; worklogId?: string; tripletexId?: string;
}

const API = "";
const WEEK_OPTS = { weekStartsOn: 1 as const };

async function fetchJSON(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

type CellKey = string; // `${date}::${projectId}`
interface CellState { id?: string; hours: string; syncedAt?: string; dirty: boolean; }

export function TimeEntries() {
  const [view, setView] = useState<"week" | "month">("week");
  const [week, setWeek] = useState(() => startOfWeek(new Date(), WEEK_OPTS));
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const weekPickerRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const from = format(week, "yyyy-MM-dd");
  const to = format(endOfWeek(week, WEEK_OPTS), "yyyy-MM-dd");
  const pullMonths = [...new Set([from.substring(0, 7), to.substring(0, 7)])];
  // Sync scope: full months covering the viewed week
  const syncFrom = from.substring(0, 7) + "-01";
  const syncTo = format(endOfMonth(parseISO(to.substring(0, 7) + "-01")), "yyyy-MM-dd");

  const { data: entries = [] } = useQuery<TimeEntry[]>({
    queryKey: ["entries", from, to],
    queryFn: () => fetchJSON(`${API}/api/entries?from=${from}&to=${to}`),
  });

  const { data: projects = [], isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => fetchJSON(`${API}/api/projects`),
  });

  const hasProjects = projects.length > 0;
  const days = eachDayOfInterval({ start: week, end: endOfWeek(week, WEEK_OPTS) });

  // Cell state map – initialised from server data, kept in sync
  const [cells, setCells] = useState<Map<CellKey, CellState>>(new Map());
  const prevEntriesRef = useRef<TimeEntry[]>([]);

  useEffect(() => {
    if (entries === prevEntriesRef.current) return;
    prevEntriesRef.current = entries;
    setCells((prev) => {
      const next = new Map<CellKey, CellState>();
      for (const e of entries) {
        const key: CellKey = `${e.date}::${e.projectId}`;
        const existing = prev.get(key);
        if (existing?.dirty) {
          next.set(key, existing); // keep unsaved local changes
        } else {
          next.set(key, { id: e.id, hours: String(e.hours), syncedAt: e.syncedAt, dirty: false });
        }
      }
      return next;
    });
  }, [entries]);

  const saveMutation = useMutation({
    mutationFn: async ({ key, state, projectId }: { key: CellKey; state: CellState; projectId: string }) => {
      const [date] = key.split("::");
      const hours = parseFloat(state.hours);
      if (!isNaN(hours) && hours > 0) {
        const body = { date, hours, projectId };
        if (state.id) {
          return fetchJSON(`${API}/api/entries/${state.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        } else {
          return fetchJSON(`${API}/api/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        }
      } else if (state.id) {
        return fetchJSON(`${API}/api/entries/${state.id}`, { method: "DELETE" });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["entries", from, to] }),
  });

  const [showPushPreview, setShowPushPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUpserts, setPreviewUpserts] = useState<PreviewUpsert[]>([]);
  const [previewDeletes, setPreviewDeletes] = useState<PreviewDelete[]>([]);
  const [pushResults, setPushResults] = useState<any[] | null>(null);

  const syncMutation = useMutation({
    mutationFn: () => fetchJSON(`${API}/api/sync/push?from=${syncFrom}&to=${syncTo}`, { method: "POST" }),
    onSuccess: (data: any) => {
      setPushResults(data?.results ?? []);
      setShowPushPreview(false);
      qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });

  async function openPushPreview() {
    setPushResults(null);
    setPreviewUpserts([]);
    setPreviewDeletes([]);
    setPreviewLoading(true);
    setShowPushPreview(true);
    try {
      const data = await fetchJSON(`${API}/api/sync/preview?from=${syncFrom}&to=${syncTo}`);
      setPreviewUpserts(data.toUpsert ?? []);
      setPreviewDeletes(data.toDelete ?? []);
    } finally {
      setPreviewLoading(false);
    }
  }

  const pullMutation = useMutation({
    mutationFn: () => Promise.all(pullMonths.map(m => fetchJSON(`${API}/api/sync/pull?month=${m}`, { method: "POST" }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["entries"] }),
  });

  function getCell(date: string, projectId: string): CellState {
    return cells.get(`${date}::${projectId}`) ?? { hours: "", dirty: false };
  }

  function updateCell(date: string, projectId: string, patch: Partial<CellState>) {
    const key: CellKey = `${date}::${projectId}`;
    setCells((prev) => {
      const existing = prev.get(key) ?? { hours: "", dirty: false };
      return new Map(prev).set(key, { ...existing, ...patch, dirty: true });
    });
  }

  function saveCell(date: string, projectId: string) {
    const key: CellKey = `${date}::${projectId}`;
    const state = cells.get(key);
    if (!state?.dirty) return;
    setCells((prev) => new Map(prev).set(key, { ...state, dirty: false }));
    saveMutation.mutate({ key, state, projectId });
  }

  // Day totals
  function dayTotal(date: string): number {
    let sum = 0;
    for (const p of projects) {
      const h = parseFloat(getCell(date, p.id).hours);
      if (!isNaN(h)) sum += h;
    }
    return sum;
  }

  const isToday = (d: Date) => format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
  const holidays = norwegianHolidays(week.getFullYear());
  const isRedDay = (d: Date) => d.getDay() === 0 || holidays.has(format(d, "yyyy-MM-dd"));

  return (
    <div>
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        {/* Left: view toggle */}
        <div style={{ display: "flex", borderRadius: 6, border: "1px solid var(--btn-border)", overflow: "hidden" }}>
          <button onClick={() => setView("week")} style={{ ...btnStyle, border: "none", borderRadius: 0, background: view === "week" ? "var(--accent)" : "var(--btn-bg)", color: view === "week" ? "var(--nav-text)" : "var(--text-secondary)" }}>Uke</button>
          <button onClick={() => setView("month")} style={{ ...btnStyle, border: "none", borderRadius: 0, borderLeft: "1px solid var(--btn-border)", background: view === "month" ? "var(--accent)" : "var(--btn-bg)", color: view === "month" ? "var(--nav-text)" : "var(--text-secondary)" }}>Måned</button>
        </div>

        {/* Center: navigation */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
          {view === "week" ? <>
            <button onClick={() => setWeek(subWeeks(week, 1))} style={btnStyle}>‹</button>
            <span
              onClick={() => (weekPickerRef.current as any)?.showPicker?.()}
              style={{ fontWeight: 600, fontSize: 16, minWidth: 220, textAlign: "center", cursor: "pointer", textDecoration: "underline dotted", textUnderlineOffset: 3, whiteSpace: "nowrap" }}
              title="Klikk for å velge uke"
            >
              Uke {format(week, "w")} – {format(week, "d. MMM", { locale: nb })} – {format(endOfWeek(week, WEEK_OPTS), "d. MMM yyyy", { locale: nb })}
            </span>
            <input
              ref={weekPickerRef}
              type="week"
              value={format(week, "yyyy-'W'ww", { useAdditionalWeekYearTokens: true })}
              onChange={e => {
                if (!e.target.value) return;
                const [y, w2] = e.target.value.split("-W").map(Number) as [number, number];
                const jan4 = new Date(y, 0, 4);
                const startOfYear = startOfWeek(jan4, WEEK_OPTS);
                setWeek(new Date(startOfYear.getTime() + (w2 - 1) * 7 * 24 * 60 * 60 * 1000));
              }}
              style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 0, height: 0 }}
            />
            <button onClick={() => setWeek(addWeeks(week, 1))} style={btnStyle}>›</button>
            <button onClick={() => setWeek(startOfWeek(new Date(), WEEK_OPTS))} style={{ ...btnStyle, fontSize: 12, color: "var(--text-muted)" }}>I dag</button>
          </> : <>
            <button onClick={() => setMonth(subMonths(month, 1))} style={btnStyle}>‹</button>
            <span style={{ fontWeight: 600, fontSize: 16, minWidth: 160, textAlign: "center", whiteSpace: "nowrap" }}>
              {format(month, "MMMM yyyy", { locale: nb })}
            </span>
            <button onClick={() => setMonth(addMonths(month, 1))} style={btnStyle}>›</button>
            <button onClick={() => setMonth(startOfMonth(new Date()))} style={{ ...btnStyle, fontSize: 12, color: "var(--text-muted)" }}>I dag</button>
          </>}
        </div>

        {/* Right: sync buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => pullMutation.mutate()} disabled={pullMutation.isPending} style={{ ...btnStyle, background: "#7c3aed", color: "#fff", whiteSpace: "nowrap" }}>
            {pullMutation.isPending ? "Henter…" : "⬇ Pull fra Tripletex"}
          </button>
          <button onClick={openPushPreview} disabled={syncMutation.isPending} style={{ ...btnStyle, background: "#059669", color: "#fff", whiteSpace: "nowrap" }}>
            {syncMutation.isPending ? "Syncing…" : "⇅ Push til Jira og Tripletex"}
          </button>
        </div>
      </div>

      {/* Status banners */}
      {pullMutation.isSuccess && (() => {
        const results = pullMutation.data as Array<{ pulled: number; skipped: number }>;
        const pulled = results.reduce((s, r) => s + r.pulled, 0);
        const skipped = results.reduce((s, r) => s + r.skipped, 0);
        return (
          <div style={bannerStyle("#ede9fe")}>
            <span>Pull ferdig: {pulled} nye importert, {skipped} uten mapping.</span>
            <button onClick={() => pullMutation.reset()} style={{ ...btnStyle, padding: "2px 8px", fontSize: 13 }}>✕</button>
          </div>
        );
      })()}
      {(pullMutation.isError || syncMutation.isError) && (
        <div style={bannerStyle("#fee2e2")}>
          Feil: {((pullMutation.error ?? syncMutation.error) as Error)?.message}
        </div>
      )}

      {/* Push results modal */}
      {pushResults && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
          <div style={{ background: "var(--surface)", borderRadius: 12, padding: 28, width: 520, maxWidth: "95vw", maxHeight: "75vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflowX: "hidden" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: 18, flexShrink: 0 }}>Push-resultat</h2>
            <div style={{ overflowY: "auto", overflowX: "hidden", flex: 1, marginBottom: 16 }}>
              {pushResults.length === 0
                ? <p style={{ color: "var(--text-muted)" }}>Ingenting å synkronisere.</p>
                : pushResults.map((r) => (
                  <div key={r.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 14, display: "flex", gap: 12, alignItems: "center" }}>
                    <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap", minWidth: 110 }}>
                      {format(new Date(r.date + "T12:00:00"), "EEE d. MMM", { locale: nb })}
                    </span>
                    <span style={{ fontWeight: 600, minWidth: 36 }}>{r.hours}t</span>
                    {r.error
                      ? <span style={{ color: "var(--red)" }}>❌ {r.error}</span>
                      : <>
                          {r.tripletex && <span style={{ color: "#059669" }}>✓ Tripletex</span>}
                          {r.jira && <span style={{ color: "var(--accent)" }}>✓ Jira</span>}
                          {!r.tripletex && !r.jira && !r.error && <span style={{ color: "var(--text-muted)" }}>Ingen endringer</span>}
                        </>
                    }
                  </div>
                ))
              }
            </div>
            <button onClick={() => setPushResults(null)} style={{ ...btnStyle, alignSelf: "flex-end" }}>Lukk</button>
          </div>
        </div>
      )}

      {/* Setup warning */}
      {view === "week" && !loadingProjects && !hasProjects && (
        <div style={{ padding: "16px 20px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600, color: "#92400e" }}>⚙️ Ingen prosjekter konfigurert</div>
            <div style={{ fontSize: 13, color: "#78350f", marginTop: 4 }}>Gå til Innstillinger for å koble prosjekter før du fører timer.</div>
          </div>
          <a href="/settings" style={{ ...btnStyle, textDecoration: "none", color: "#92400e", borderColor: "#f59e0b", background: "#fef3c7" }}>
            Innstillinger →
          </a>
        </div>
      )}

      {/* Monthly view */}
      {view === "month" && (
        <MonthView month={month} setMonth={setMonth} onWeekClick={(weekStart) => { setWeek(weekStart); setView("week"); }} />
      )}

      {/* Weekly grid */}
      {view === "week" && hasProjects && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={thStyle("left")}>Prosjekt</th>
              {days.map((d) => (
                <th key={d.toISOString()} style={{ ...thStyle("center"), background: isToday(d) ? "var(--bg-blue-tint)" : isRedDay(d) ? "var(--bg-red-tint)" : "var(--bg-subtle)" }}>
                  <div style={{ fontWeight: 600, color: isToday(d) ? "var(--accent)" : isRedDay(d) ? "var(--red)" : "var(--text-secondary)" }}>
                    {format(d, "EEE", { locale: nb })}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 400, color: isRedDay(d) ? "var(--red)" : "var(--text-muted)" }}>
                    {format(d, "d. MMM", { locale: nb })}
                  </div>
                </th>
              ))}
              <th style={{ ...thStyle("center"), width: 70 }}>Sum</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const rowTotal = days.reduce((sum, d) => {
                const h = parseFloat(getCell(format(d, "yyyy-MM-dd"), project.id).hours);
                return sum + (isNaN(h) ? 0 : h);
              }, 0);
              return (
                <tr key={project.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 12px", fontWeight: 500, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={project.displayName}>
                    {project.displayName}
                  </td>
                  {days.map((d) => {
                    const dateStr = format(d, "yyyy-MM-dd");
                    const cell = getCell(dateStr, project.id);
                    const synced = cell.syncedAt && !cell.dirty;
                    return (
                      <td key={d.toISOString()} style={{ padding: "4px 4px", textAlign: "center", background: isToday(d) ? "var(--bg-blue-tint)" : isRedDay(d) ? "var(--bg-red-tint)" : "transparent" }}>
                        <div style={{ position: "relative", display: "inline-block" }}>
                          <input
                            type="number"
                            min="0"
                            max="24"
                            step="0.5"
                            placeholder=""
                            value={cell.hours}
                            onChange={(e) => updateCell(dateStr, project.id, { hours: e.target.value })}
                            onBlur={() => saveCell(dateStr, project.id)}
                            style={{
                              width: "100%",
                              textAlign: "center",
                              padding: "7px 4px",
                              border: `1px solid ${cell.dirty ? "#f59e0b" : synced ? "#86efac" : "var(--input-border)"}`,
                              borderRadius: 6,
                              fontSize: 14,
                              background: synced ? "#f0fdf4" : "var(--input-bg)",
                              outline: "none",
                              color: "var(--text-primary)",
                              boxSizing: "border-box",
                            }}
                          />
                          {synced && (
                            <span style={{ position: "absolute", top: -4, right: -4, fontSize: 9, color: "var(--green)" }}>✓</span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td style={{ padding: "6px 12px", textAlign: "center", fontWeight: 600, color: rowTotal > 0 ? "var(--text-primary)" : "var(--text-disabled)" }}>
                    {rowTotal > 0 ? rowTotal : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "2px solid var(--border)", background: "var(--bg-subtle)" }}>
              <td style={{ padding: "8px 12px", fontWeight: 600, color: "var(--text-secondary)" }}>Sum</td>
              {days.map((d) => {
                const total = dayTotal(format(d, "yyyy-MM-dd"));
                return (
                  <td key={d.toISOString()} style={{ textAlign: "center", padding: "8px 4px", fontWeight: 600, color: total > 0 ? "var(--text-primary)" : "var(--text-disabled)", background: isToday(d) ? "var(--bg-blue-tint)" : isRedDay(d) ? "var(--bg-red-tint)" : "transparent" }}>
                    {total > 0 ? total : "–"}
                  </td>
                );
              })}
              <td style={{ textAlign: "center", padding: "8px 12px", fontWeight: 700 }}>
                {days.reduce((sum, d) => sum + dayTotal(format(d, "yyyy-MM-dd")), 0) || "–"}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      {showPushPreview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
          <div style={{ background: "var(--surface)", borderRadius: 12, padding: 28, width: 560, maxWidth: "95vw", maxHeight: "75vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflowX: "hidden" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>Bekreft push</h2>
            {previewLoading ? (
              <p style={{ color: "var(--text-muted)", flex: 1 }}>Henter endringer…</p>
            ) : previewUpserts.length === 0 && previewDeletes.length === 0 ? (
              <p style={{ color: "var(--text-muted)", flex: 1 }}>Ingen endringer å synkronisere.</p>
            ) : (
              <div style={{ overflowY: "auto", flex: 1, marginBottom: 16 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <tbody>
                    {previewUpserts.length > 0 && (() => {
                      // Group by date+projectName+hours
                      const groups = new Map<string, { item: PreviewUpsert; connectors: string[] }>();
                      for (const item of previewUpserts) {
                        const key = `${item.date}::${item.projectName}::${item.hours}`;
                        if (!groups.has(key)) groups.set(key, { item, connectors: [] });
                        groups.get(key)!.connectors.push(item.connector === "jira" ? "Jira" : "Tripletex");
                      }
                      return <>
                        <tr><td colSpan={4} style={{ padding: "8px 8px 4px", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Legger til</td></tr>
                        {[...groups.values()].map(({ item, connectors }, i) => (
                          <tr key={`u${i}`} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                              {format(new Date(item.date + "T12:00:00"), "EEE d. MMM", { locale: nb })}
                            </td>
                            <td style={{ padding: "6px 8px", fontWeight: 600 }}>{item.hours}t</td>
                            <td style={{ padding: "6px 8px" }}>{item.projectName}</td>
                            <td style={{ padding: "6px 8px", display: "flex", gap: 4 }}>
                              {connectors.map(c => <span key={c} style={actionBadge(item.action as "create" | "update")}>{c}</span>)}
                            </td>
                          </tr>
                        ))}
                      </>;
                    })()}
                    {previewDeletes.length > 0 && (() => {
                      const groups = new Map<string, { item: PreviewDelete; connectors: string[] }>();
                      for (const item of previewDeletes) {
                        const ref = item.ref ?? item.connector;
                        const key = `${item.date}::${ref}::${item.hours}`;
                        if (!groups.has(key)) groups.set(key, { item, connectors: [] });
                        groups.get(key)!.connectors.push(item.connector === "jira" ? "Jira" : "Tripletex");
                      }
                      return <>
                        <tr><td colSpan={4} style={{ padding: "12px 8px 4px", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Sletter</td></tr>
                        {[...groups.values()].map(({ item, connectors }, i) => (
                          <tr key={`d${i}`} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                              {format(new Date(item.date + "T12:00:00"), "EEE d. MMM", { locale: nb })}
                            </td>
                            <td style={{ padding: "6px 8px", fontWeight: 600 }}>{item.hours}t</td>
                            <td style={{ padding: "6px 8px", color: "var(--text-secondary)" }}>{item.ref ?? "—"}</td>
                            <td style={{ padding: "6px 8px", display: "flex", gap: 4 }}>
                              {connectors.map(c => (
                                <span key={c} style={{ display: "inline-block", padding: "2px 8px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: "#fee2e2", color: "#dc2626" }}>
                                  Slett {c}
                                </span>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </>;
                    })()}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setShowPushPreview(false)} style={btnStyle}>Avbryt</button>
              {!previewLoading && (previewUpserts.length > 0 || previewDeletes.length > 0) && (
                <button
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                  style={{ ...btnStyle, background: "#059669", color: "#fff", borderColor: "#059669" }}
                >
                  {syncMutation.isPending ? "Sender…" : "Bekreft"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function actionBadge(action: "create" | "update"): React.CSSProperties {
  return {
    display: "inline-block", padding: "2px 8px", borderRadius: 99, fontSize: 12, fontWeight: 600,
    background: action === "create" ? "#dbeafe" : "#fef9c3",
    color: action === "create" ? "#1d4ed8" : "#854d0e",
  };
}

const btnStyle: React.CSSProperties = { height: 34, padding: "0 14px", border: "1px solid var(--btn-border)", borderRadius: 6, background: "var(--btn-bg)", fontSize: 14, cursor: "pointer", display: "inline-flex", alignItems: "center", boxSizing: "border-box" };
const bannerStyle = (bg: string): React.CSSProperties => ({ padding: "8px 12px", background: bg, borderRadius: 6, marginBottom: 12, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "space-between" });
function thStyle(align: "left" | "center"): React.CSSProperties {
  return { padding: "10px 12px", textAlign: align, background: "var(--bg-subtle)", borderBottom: "2px solid var(--border)", fontWeight: 600, color: "var(--text-secondary)" };
}

/** Compute Norwegian public holidays for a given year as a Set of "yyyy-MM-dd" strings */
function norwegianHolidays(year: number): Set<string> {
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const d = (m: number, day: number) => fmt(new Date(year, m - 1, day));
  // Easter Sunday via Meeus/Jones/Butcher algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const e = Math.floor(b / 4), f = b % 4, g = Math.floor((b + 8) / 25);
  const h = Math.floor((b - g + 1) / 3), i = (19 * a + b - e - h + 15) % 30;
  const k = Math.floor(c / 4), l = c % 4;
  const m2 = (32 + 2 * f + 2 * k - i - l) % 7;
  const n = Math.floor((a + 11 * i + 22 * m2) / 451);
  const month = Math.floor((i + m2 - 7 * n + 114) / 31);
  const day = ((i + m2 - 7 * n + 114) % 31) + 1;
  const easter = new Date(year, month - 1, day);
  const off = (days: number) => { const x = new Date(easter); x.setDate(x.getDate() + days); return fmt(x); };
  return new Set([
    d(1, 1),   // Nyttår
    off(-3),   // Skjærtorsdag
    off(-2),   // Langfredag
    off(0),    // 1. påskedag
    off(1),    // 2. påskedag
    d(5, 1),   // Arbeidernes dag
    d(5, 17),  // Grunnlovsdag
    off(39),   // Kristi himmelfartsdag
    off(49),   // 1. pinsedag
    off(50),   // 2. pinsedag
    d(12, 25), // 1. juledag
    d(12, 26), // 2. juledag
  ]);
}
