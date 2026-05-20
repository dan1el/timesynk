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
        <header style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
          <div style={{ maxWidth: 1000, margin: "0 auto", padding: "12px 24px", display: "flex", gap: "24px", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: 18, marginRight: 16, lineHeight: 1 }}>⏱ timesynk</span>
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
          </div>
        </header>
        <main style={{ padding: "24px", maxWidth: 1000, margin: "0 auto" }}>
          <Routes>
            <Route path="/" element={<TimeEntries />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
        <footer style={{ position: "fixed", bottom: 16, right: 20, zIndex: 50 }}>
          <a
            href="https://github.com/dan1el/timesynk"
            target="_blank"
            rel="noopener noreferrer"
            title="timesynk på GitHub"
            style={{ display: "flex", alignItems: "center", opacity: 0.35, transition: "opacity 0.15s" }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "0.35")}
          >
            <svg height="22" width="22" viewBox="0 0 16 16" fill="var(--text-primary)" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
                .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
                -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
                .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
                .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
                0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
        </footer>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
