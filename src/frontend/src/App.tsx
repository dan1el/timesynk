import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TimeEntries } from "./pages/TimeEntries";
import { Settings } from "./pages/Settings";
import "./App.css";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <header style={{ padding: "12px 24px", borderBottom: "1px solid #e5e7eb", display: "flex", gap: "24px", alignItems: "center", background: "#fff" }}>
          <span style={{ fontWeight: 700, fontSize: 18, marginRight: 16 }}>⏱ TimeLog</span>
          <NavLink to="/" end style={({ isActive }) => ({ color: isActive ? "#2563eb" : "#374151", textDecoration: "none", fontWeight: 500 })}>
            Timeliste
          </NavLink>
          <NavLink to="/settings" style={({ isActive }) => ({ color: isActive ? "#2563eb" : "#374151", textDecoration: "none", fontWeight: 500 })}>
            Innstillinger
          </NavLink>
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
