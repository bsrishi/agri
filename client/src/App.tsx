import React, { useState, useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import AppShell from "./components/AppShell";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Leads from "./pages/Leads";
import FetchInfo from "./pages/FetchInfo";
import BulkJobs from "./pages/BulkJobs";

export default function App() {
  const [token, setToken] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("sla_token");
    }
    return null;
  });

  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== "undefined") {
      const theme = localStorage.getItem("theme");
      if (theme) {
        return theme === "dark";
      }
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return false;
  });

  const toggleDarkMode = () => {
    setDarkMode((prev) => {
      const newMode = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("theme", newMode ? "dark" : "light");
        if (newMode) {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      }
      return newMode;
    });
  };

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === "sla_token") {
        setToken(event.newValue);
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  return (
    <div className={darkMode ? "dark" : ""}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/portal/*" element={token ? <PortalLayout darkMode={darkMode} toggleDarkMode={toggleDarkMode} /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to={token ? "/portal" : "/login"} replace />} />
      </Routes>
    </div>
  );
}

function PortalLayout({ darkMode, toggleDarkMode }: { darkMode: boolean; toggleDarkMode: () => void }) {
  const navigate = useNavigate();
  const loc = useLocation();

  const navItems = [
    { key: "dashboard", label: "Dashboard", to: "/portal/dashboard" },
    { key: "leads", label: "Leads", to: "/portal/leads" },
    { key: "fetch", label: "Fetch Info", to: "/portal/fetch" },
    { key: "bulk", label: "Bulk Jobs", to: "/portal/bulk" },
  ];

  const activeKey = (() => {
    if (loc.pathname.startsWith("/portal/leads")) return "leads";
    if (loc.pathname.startsWith("/portal/fetch")) return "fetch";
    if (loc.pathname.startsWith("/portal/bulk")) return "bulk";
    return "dashboard";
  })();

  return (
    <AppShell
      companyName="Sri Lakshmi Agro"
      onHome={() => navigate("/portal/dashboard")}
      onLogout={() => { localStorage.removeItem("sla_token"); navigate("/login", { replace: true }); }}
      navItems={navItems}
      activeKey={activeKey}
      onNavigate={(key) => {
        const to = navItems.find(i => i.key === key)?.to || "/portal/dashboard";
        navigate(to);
      }}
      darkMode={darkMode}
      toggleDarkMode={toggleDarkMode}
    >
      <Routes>
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="leads" element={<Leads />} />
        <Route path="fetch" element={<FetchInfo />} />
        <Route path="bulk" element={<BulkJobs />} />
        <Route index element={<Navigate to="dashboard" replace />} />
      </Routes>
    </AppShell>
  );
}