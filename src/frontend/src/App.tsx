import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TimeEntries } from "./pages/TimeEntries";
import { Settings } from "./pages/Settings";
import "./App.css";

const queryClient = new QueryClient();

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--border)", display: "flex", gap: "24px", alignItems: "center", background: "var(--bg)" }}>
          <span style={{ fontWeight: 700, fontSize: 18, marginRight: 16 }}>⏱ TimeLog</span>
          <NavLink to="/" end style={({ isActive }) => ({ color: isActive ? "var(--accent)" : "var(--text-secondary)", textDecoration: "none", fontWeight: 500 })}>
            Timeliste
          </NavLink>
          <NavLink to="/settings" style={({ isActive }) => ({ color: isActive ? "var(--accent)" : "var(--text-secondary)", textDecoration: "none", fontWeight: 500 })}>
            Innstillinger
          </NavLink>
          <button
            onClick={() => setDark(d => !d)}
            title={dark ? "Bytt til lys modus" : "Bytt til mørk modus"}
            style={{ marginLeft: "auto", background: "var(--btn-bg)", border: "1px solid var(--btn-border)", borderRadius: 6, padding: "4px 10px", fontSize: 18, cursor: "pointer", lineHeight: 1 }}
          >
            {dark ? "☀️" : "🌙"}
          </button>
        </header>
        <main style={{ padding: "24px", maxWidth: 1000, margin: "0 auto" }}>
          <Routes>
            <Route path="/" element={<TimeEntries />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
