import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachWeekOfInterval, eachDayOfInterval,
} from "date-fns";
import { nb } from "date-fns/locale";
import type { TimeEntry } from "../../../shared/types";

const API = "";
const WEEK_OPTS = { weekStartsOn: 1 as const };

async function fetchJSON(url: string, opts?: RequestInit) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return null;
  return r.json();
}

const DAY_HEADERS = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];

interface Project { id: string; displayName: string; }
type CellKey = string; // `${date}::${projectId}`
interface CellState { id?: string; hours: string; dirty: boolean; }

function norwegianHolidays(year: number): Set<string> {
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const d = (m: number, day: number) => fmt(new Date(year, m - 1, day));
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
    d(1, 1), off(-3), off(-2), off(0), off(1),
    d(5, 1), d(5, 17), off(39), off(49), off(50),
    d(12, 25), d(12, 26),
  ]);
}

interface Props {
  month: Date;
  setMonth: (d: Date) => void;
  onWeekClick: (weekStart: Date) => void;
}

export function MonthView({ month, setMonth, onWeekClick }: Props) {
  const [expandedWeek, setExpandedWeek] = useState<string | null>(null);
  const [cells, setCells] = useState<Map<CellKey, CellState>>(new Map());
  const qc = useQueryClient();
  const tableRef = useRef<HTMLTableElement>(null);
  const focusTargetRef = useRef<"first" | "last" | null>(null);

  // Reset expanded week when month changes
  useEffect(() => {
    setExpandedWeek(null);
  }, [month]);

  const from = format(startOfWeek(startOfMonth(month), WEEK_OPTS), "yyyy-MM-dd");
  const to = format(endOfWeek(endOfMonth(month), WEEK_OPTS), "yyyy-MM-dd");

  const { data: entries = [] } = useQuery<TimeEntry[]>({
    queryKey: ["entries", from, to],
    queryFn: () => fetchJSON(`${API}/api/entries?from=${from}&to=${to}`),
  });

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => fetchJSON(`${API}/api/projects`),
  });

  // Sync entries into cells whenever expanded week or entries change
  useEffect(() => {
    if (!expandedWeek) return;
    const weekStart = new Date(expandedWeek + "T12:00:00");
    const days = eachDayOfInterval({ start: weekStart, end: endOfWeek(weekStart, WEEK_OPTS) });
    const next = new Map<CellKey, CellState>();
    for (const d of days) {
      const dateStr = format(d, "yyyy-MM-dd");
      for (const p of projects) {
        const key = `${dateStr}::${p.id}`;
        const entry = entries.find(e => e.date === dateStr && e.projectId === p.id);
        next.set(key, { id: entry?.id, hours: entry ? String(entry.hours) : "", dirty: false });
      }
    }
    setCells(next);
    // Focus first/last input after cells render
    if (focusTargetRef.current) {
      const target = focusTargetRef.current;
      focusTargetRef.current = null;
      setTimeout(() => {
        const inputs = tableRef.current?.querySelectorAll<HTMLInputElement>('input[type="number"]');
        if (!inputs?.length) return;
        (target === "first" ? inputs[0] : inputs[inputs.length - 1]).focus();
      }, 30);
    }
  }, [expandedWeek, entries, projects]);

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["entries"] }),
  });

  function updateCell(date: string, projectId: string, hours: string) {
    const key = `${date}::${projectId}`;
    setCells(m => new Map(m).set(key, { ...m.get(key)!, hours, dirty: true }));
  }

  function saveCell(date: string, projectId: string) {
    const key = `${date}::${projectId}`;
    const state = cells.get(key);
    if (!state?.dirty) return;
    saveMutation.mutate({ key, state, projectId });
    setCells(m => new Map(m).set(key, { ...state, dirty: false }));
  }

  // Map date → total hours (for collapsed rows)
  const totals = new Map<string, number>();
  for (const e of entries) {
    totals.set(e.date, (totals.get(e.date) ?? 0) + e.hours);
  }

  const weeks = eachWeekOfInterval(
    { start: startOfMonth(month), end: endOfMonth(month) },
    WEEK_OPTS,
  );

  const holidays = norwegianHolidays(month.getFullYear());
  const dateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const isRedDay = (d: Date) => d.getDay() === 0 || holidays.has(dateStr(d));
  const isToday = (d: Date) => dateStr(d) === dateStr(new Date());
  const inMonth = (d: Date) => d.getMonth() === month.getMonth();

  const monthTotal = weeks.reduce((s, ws) => {
    const days = eachDayOfInterval({ start: ws, end: endOfWeek(ws, WEEK_OPTS) });
    return s + days.filter(inMonth).reduce((ss, d) => ss + (totals.get(format(d, "yyyy-MM-dd")) ?? 0), 0);
  }, 0);

  function toggleWeek(weekStartISO: string) {
    setExpandedWeek(prev => prev === weekStartISO ? null : weekStartISO);
  }

  function expandWeekAndFocus(weekISO: string, target: "first" | "last") {
    focusTargetRef.current = target;
    setExpandedWeek(weekISO);
  }

  return (
    <div>
      {monthTotal > 0 && (
        <div style={{ marginBottom: 12, fontSize: 14, color: "var(--text-muted)" }}>
          Totalt denne måneden: <strong>{monthTotal}t</strong>
        </div>
      )}

      <table ref={tableRef} style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            <th style={thStyle("left", false)}>Uke</th>
            {DAY_HEADERS.map((d) => (
              <th key={d} style={thStyle("center", d === "Lør" || d === "Søn")}>{d}</th>
            ))}
            <th style={thStyle("center", false)}>Sum</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((weekStart) => {
            const weekStartISO = format(weekStart, "yyyy-MM-dd");
            const days = eachDayOfInterval({ start: weekStart, end: endOfWeek(weekStart, WEEK_OPTS) });
            const isExpanded = expandedWeek === weekStartISO;

            if (isExpanded) {
              // Expanded: project rows with input fields
              const weekDayTotals = days.map(d => {
                const ds = format(d, "yyyy-MM-dd");
                return projects.reduce((s, p) => {
                  const v = parseFloat(cells.get(`${ds}::${p.id}`)?.hours ?? "");
                  return s + (isNaN(v) ? 0 : v);
                }, 0);
              });
              const weekTotal = weekDayTotals.reduce((a, b) => a + b, 0);

              return [
                // Day-number header sub-row
                <tr key={`${weekStartISO}-header`} style={{ background: "var(--bg-blue-tint)", borderBottom: "1px solid var(--border-blue)" }}>
                  <td
                    onClick={() => toggleWeek(weekStartISO)}
                    style={{ padding: "10px 12px", fontWeight: 700, color: "var(--accent)", cursor: "pointer", fontSize: 14, whiteSpace: "nowrap" }}
                  >
                    Uke {format(weekStart, "w", { locale: nb })} ▴
                    <span
                      onClick={e => { e.stopPropagation(); onWeekClick(weekStart); }}
                      title="Åpne i ukesvisning"
                      style={{ marginLeft: 8, fontSize: 12, color: "var(--text-placeholder)", fontWeight: 400, textDecoration: "underline" }}
                    >↗ ukevisning</span>
                  </td>
                  {days.map(d => {
                    const red = isRedDay(d);
                    const today = isToday(d);
                    return (
                      <td key={d.toISOString()} style={{ padding: "10px 8px", textAlign: "center", fontSize: 14, color: today ? "var(--accent)" : red ? "var(--red)" : "var(--text-muted)", fontWeight: today ? 700 : 400 }}>
                        {format(d, "d. MMM", { locale: nb })}
                      </td>
                    );
                  })}
                  <td />
                </tr>,
                // Project rows
                ...projects.map((project, pIdx) => {
                  const rowTotal = days.reduce((s, d) => {
                    const v = parseFloat(cells.get(`${format(d, "yyyy-MM-dd")}::${project.id}`)?.hours ?? "");
                    return s + (isNaN(v) ? 0 : v);
                  }, 0);
                  const weekIdx = weeks.findIndex(w => format(w, "yyyy-MM-dd") === weekStartISO);
                  return (
                    <tr key={`${weekStartISO}-${project.id}`} style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-row-hover)" }}>
                      <td style={{ padding: "6px 12px", fontSize: 14, color: "var(--text-secondary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {project.displayName}
                      </td>
                      {days.map((d, dIdx) => {
                        const ds = format(d, "yyyy-MM-dd");
                        const key = `${ds}::${project.id}`;
                        const cell = cells.get(key) ?? { hours: "", dirty: false };
                        const red = isRedDay(d);
                        const today = isToday(d);
                        const outside = !inMonth(d);
                        const isFirst = pIdx === 0 && dIdx === 0;
                        const isLast = pIdx === projects.length - 1 && dIdx === days.length - 1;
                        return (
                          <td key={ds} style={{ padding: "4px 4px", textAlign: "center", background: today ? "var(--bg-blue-tint)" : red ? "var(--bg-red-tint)" : outside ? "var(--bg-muted)" : "transparent" }}>
                            {outside ? (
                              <span style={{ fontSize: 14, color: "var(--text-disabled)" }}>
                                {cell.hours ? `${cell.hours}t` : "–"}
                              </span>
                            ) : (
                            <input
                              type="number" min="0" max="24" step="0.5"
                              placeholder=""
                              value={cell.hours}
                              onChange={e => updateCell(ds, project.id, e.target.value)}
                              onBlur={() => saveCell(ds, project.id)}
                              onKeyDown={e => {
                                if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); return; }
                                if (e.key === "Tab" && !e.shiftKey && isLast && weekIdx < weeks.length - 1) {
                                  e.preventDefault();
                                  saveCell(ds, project.id);
                                  expandWeekAndFocus(format(weeks[weekIdx + 1], "yyyy-MM-dd"), "first");
                                }
                                if (e.key === "Tab" && e.shiftKey && isFirst && weekIdx > 0) {
                                  e.preventDefault();
                                  saveCell(ds, project.id);
                                  expandWeekAndFocus(format(weeks[weekIdx - 1], "yyyy-MM-dd"), "last");
                                }
                              }}
                              style={{ width: "100%", padding: "7px 4px", border: `1px solid ${cell.dirty ? "#f59e0b" : "var(--input-border)"}`, borderRadius: 6, fontSize: 14, textAlign: "center", background: "var(--input-bg)", outline: "none", color: "var(--text-primary)", boxSizing: "border-box" }}
                            />
                            )}
                          </td>
                        );
                      })}
                      <td style={{ padding: "6px 12px", textAlign: "center", fontSize: 14, color: rowTotal > 0 ? "var(--text-secondary)" : "var(--text-disabled)", fontWeight: 600 }}>
                        {rowTotal > 0 ? `${rowTotal}t` : "–"}
                      </td>
                    </tr>
                  );
                }),
                // Day totals row
                <tr key={`${weekStartISO}-total`} style={{ borderBottom: "2px solid var(--border-blue)", background: "var(--bg-blue-tint)" }}>
                  <td style={{ padding: "8px 12px", fontSize: 14, color: "var(--text-muted)", fontWeight: 600 }}>Sum</td>
                  {weekDayTotals.map((t, i) => (
                    <td key={i} style={{ padding: "8px 4px", textAlign: "center", fontSize: 14, fontWeight: 600, color: t > 0 ? "var(--accent-dark)" : "var(--text-disabled)" }}>
                      {t > 0 ? `${t}t` : "–"}
                    </td>
                  ))}
                  <td style={{ padding: "8px 12px", textAlign: "center", fontSize: 14, fontWeight: 700, color: weekTotal > 0 ? "var(--accent-dark)" : "var(--text-disabled)" }}>
                    {weekTotal > 0 ? `${weekTotal}t` : "–"}
                  </td>
                </tr>,
              ];
            }

            // Collapsed: summary row
            const weekSum = days.filter(inMonth).reduce((s, d) => s + (totals.get(format(d, "yyyy-MM-dd")) ?? 0), 0);

            return (
              <tr key={weekStartISO} style={{ borderBottom: "1px solid var(--border)" }}>
                <td
                  onClick={() => toggleWeek(weekStartISO)}
                  style={{ padding: "10px 12px", fontWeight: 600, color: "var(--accent)", cursor: "pointer", whiteSpace: "nowrap", fontSize: 14 }}
                >
                  Uke {format(weekStart, "w", { locale: nb })}
                </td>
                {days.map((d) => {
                  const ds = format(d, "yyyy-MM-dd");
                  const hours = totals.get(ds);
                  const outside = !inMonth(d);
                  const red = isRedDay(d);
                  const today = isToday(d);
                  const bg = today ? "var(--bg-blue-tint)" : red ? "var(--bg-red-tint)" : outside ? "var(--bg-muted)" : "transparent";
                  const color = outside ? "var(--text-disabled)" : red ? "var(--red)" : hours ? "var(--text-primary)" : "var(--text-placeholder)";
                  return (
                    <td
                      key={ds}
                      onClick={() => toggleWeek(weekStartISO)}
                      style={{ padding: "10px 8px", textAlign: "center", background: bg, color, fontWeight: hours && !outside ? 600 : 400, cursor: "pointer" }}
                    >
                      <div style={{ fontSize: 11, color: outside ? "var(--text-faint)" : red ? "var(--red-light)" : "var(--text-placeholder)", marginBottom: 2 }}>
                        {format(d, "d")}
                      </div>
                      {outside ? "" : hours ? `${hours}t` : <span style={{ color: "var(--text-faint)" }}>·</span>}
                    </td>
                  );
                })}
                <td style={{ padding: "10px 8px", textAlign: "center", fontWeight: 700, color: weekSum > 0 ? "var(--text-primary)" : "var(--text-disabled)" }}>
                  {weekSum > 0 ? `${weekSum}t` : "–"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const btnStyle: React.CSSProperties = { height: 34, padding: "0 14px", border: "1px solid var(--btn-border)", borderRadius: 6, background: "var(--btn-bg)", fontSize: 14, cursor: "pointer", display: "inline-flex", alignItems: "center", boxSizing: "border-box" };
function thStyle(align: "left" | "center", red: boolean): React.CSSProperties {
  return { padding: "10px 12px", textAlign: align, background: red ? "var(--bg-red-tint)" : "var(--bg-subtle)", borderBottom: "2px solid var(--border)", fontWeight: 600, color: red ? "var(--red)" : "var(--text-secondary)" };
}
