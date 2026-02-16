// client/src/components/AppShell.tsx
import React from "react";
import { NavLink } from "react-router-dom";
import { http } from "../lib/http";

/**
 * Nathiya Agri Agency – Professional AppShell
 * - Green theme, stunning + minimal
 * - Collapsible (explode/implode) sidebar
 * - Dark/Light toggle, Logout, Zoom/Search button in header
 * - Bigger logo (served from /public as /sla-icon.png)
 * - No external icon deps: all icons inline SVGs
 * - Works with your existing props from App.tsx
 */

type NavItem = {
  key: string;
  to?: string;
  href?: string;
  label: string;
  icon?: React.ReactNode;
};

type Props = {
  companyName: string;
  onHome: () => void;
  onLogout: () => void;
  navItems: NavItem[];
  activeKey: string;
  onNavigate: (key: string) => void;
  children: React.ReactNode;
  darkMode: boolean;
  toggleDarkMode: () => void;
  userName?: string;
  userPhone?: string;
};

function initialsFromName(name?: string | null) {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const first = parts[0] || "";
  return (first.slice(0, 2) || "U").toUpperCase();
}

function readLocalUser() {
  try {
    const raw = localStorage.getItem("sla_user");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const name = typeof parsed?.name === "string" ? parsed.name : null;
    const phone = typeof parsed?.phone === "string" ? parsed.phone : null;
    return { name, phone };
  } catch {
    return null;
  }
}

export default function AppShell({
  companyName,
  onHome,
  onLogout,
  navItems,
  activeKey,
  onNavigate,
  children,
  darkMode,
  toggleDarkMode,
  userName,
  userPhone,
}: Props) {
  const [uName, setUName] = React.useState<string | null>(() => {
    if (userName != null) return userName;
    const lu = typeof window !== "undefined" ? readLocalUser() : null;
    return lu?.name ?? null;
  });
  const [uPhone, setUPhone] = React.useState<string | null>(() => {
    if (userPhone != null) return userPhone;
    const lu = typeof window !== "undefined" ? readLocalUser() : null;
    return lu?.phone ?? null;
  });

  React.useEffect(() => {
    let cancelled = false;
    // 1) Try localStorage (sla_user)
    try {
      const lu = readLocalUser();
      if (lu) {
        if (!cancelled && lu.name != null) setUName(String(lu.name));
        if (!cancelled && lu.phone != null) setUPhone(String(lu.phone));
      }
    } catch {}

    // 2) Then best-effort API fetch (keeps working if backend available)
    (async () => {
      try {
        const res = await http.get("/api/users/me", { validateStatus: () => true });
        if (!cancelled && res && res.status >= 200 && res.status < 300) {
          const n = res.data?.name ?? null;
          const p = res.data?.phone ?? null;
          if (n !== null) setUName(String(n));
          if (p !== null) setUPhone(String(p));
        }
      } catch {
        // ignore
      }
    })();

    // 3) Listen for cross-tab/local updates to sla_user
    function onStorage(e: StorageEvent) {
      if (e.key === "sla_user") {
        const lu = readLocalUser();
        if (lu) {
          setUName(lu.name ?? null);
          setUPhone(lu.phone ?? null);
        }
      }
    }
    window.addEventListener("storage", onStorage);
    return () => { cancelled = true; window.removeEventListener("storage", onStorage); };
  }, []);

  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem("sla_sidebar_collapsed") === "1";
    } catch {
      return false;
    }
  });

  // Mobile drawer state (for < md screens)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  // Lock body scroll when drawer is open
  React.useEffect(() => {
    if (mobileNavOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [mobileNavOpen]);

  React.useEffect(() => {
    try {
      localStorage.setItem("sla_sidebar_collapsed", collapsed ? "1" : "0");
    } catch {}
  }, [collapsed]);

  // Dynamic Zoom (affects root font-size so all rem scale)
  const [zoom, setZoom] = React.useState<number>(() => {
    const saved = Number(localStorage.getItem("sla_zoom"));
    return Number.isFinite(saved) && saved >= 85 && saved <= 150 ? saved : 115;
  });
  React.useEffect(() => {
    document.documentElement.style.fontSize = zoom + "%";
    try { localStorage.setItem("sla_zoom", String(zoom)); } catch {}
  }, [zoom]);
  const applyZoom = (val: number) => setZoom(Math.min(150, Math.max(85, Math.round(val))));
  const zoomIn = () => applyZoom(zoom + 5);
  const zoomOut = () => applyZoom(zoom - 5);

  const [zoomOpen, setZoomOpen] = React.useState(false);
  const zoomHoverTimer = React.useRef<number | null>(null);

  const openZoom = () => {
    if (zoomHoverTimer.current) window.clearTimeout(zoomHoverTimer.current);
    setZoomOpen(true);
  };
  const closeZoom = () => {
    if (zoomHoverTimer.current) window.clearTimeout(zoomHoverTimer.current);
    // small grace so moving from the icon into the panel doesn't close it
    zoomHoverTimer.current = window.setTimeout(() => setZoomOpen(false), 150);
  };

  React.useEffect(() => {
    return () => {
      if (zoomHoverTimer.current) window.clearTimeout(zoomHoverTimer.current);
    };
  }, []);

  // Utility to resolve route safely
  const resolveTo = (item: NavItem) => item.to ?? item.href ?? "#";

  // Detect if a Bulk item is already present in navItems
  const hasBulk = navItems?.some(i => {
    const key = (i?.key || "").toLowerCase();
    const lbl = (i?.label || "").toLowerCase();
    const dest = (i?.to || i?.href || "");
    return key === "bulk" || lbl.includes("bulk") || dest === "/portal/bulk";
  }) ?? false;

  return (
    <div
      className="flex h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100 font-sans antialiased text-[15px] sm:text-[15.5px] md:text-[16px]"
      style={{
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Apple Color Emoji', 'Segoe UI Emoji'",
      }}
    >
      {/* Sidebar */}
      <aside
        aria-label="Sidebar Navigation"
        className={[
          "hidden md:flex flex-col border-r shadow-sm transition-[width] duration-200 ease-out",
          "bg-white/95 dark:bg-slate-900/95 backdrop-blur",
          "border-slate-200 dark:border-slate-800",
          collapsed ? "w-16" : "w-64",
        ].join(" ")}
      >
        {/* Brand / Collapse */}
        <div className={[
          "flex h-16 items-center px-0 border-b border-slate-200 dark:border-slate-800",
          collapsed ? "justify-center" : "justify-start"
        ].join(" ")}
        >
          <button
            onClick={onHome}
            title={companyName}
            aria-label={`${companyName} home`}
            className={[
              "flex items-center px-0 py-1 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30",
              collapsed ? "gap-0" : "gap-3"
            ].join(" ")}
          >
            {/* Keep logo size constant to avoid flicker/resize */}
            {/* Logo removed as per request */}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3" role="navigation">
          {navItems.map((item) => {
            const itemTo = resolveTo(item);
            const isActiveKey = activeKey === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.key)}
                className="w-full text-left"
              >
                <NavLink
                  to={itemTo}
                  // When overview is at /portal/dashboard, mark that exact route as end if provided
                  end={itemTo ? itemTo.endsWith("/dashboard") : false}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    [
                      "group relative mx-2 my-1 flex items-center rounded-lg px-3 py-2 text-sm transition-colors",
                      (isActive || isActiveKey)
                        ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-500/40"
                        : "text-slate-700 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-slate-800",
                      collapsed ? "justify-center" : "justify-start",
                    ].join(" ")
                  }
                >
                  {({ isActive }) => (
                    <>
                      {/* Left accent */}
                      <span
                        aria-hidden
                        className={[
                          "absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r transition-colors",
                          (isActive || isActiveKey) ? "bg-white/90" : "bg-transparent group-hover:bg-emerald-300 dark:group-hover:bg-emerald-600",
                        ].join(" ")}
                      />
                      {/* Icon */}
                      <span className="shrink-0">
                        {item.icon ?? defaultIconFor(item.key)}
                      </span>
                      {/* Label */}
                      {!collapsed && <span className="ml-3 font-medium">{item.label}</span>}
                      {/* Tooltip when collapsed */}
                      {collapsed && (
                        <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 rounded-md bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900 text-xs px-2 py-1 opacity-0 group-hover:opacity-100 shadow">
                          {item.label}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              </button>
            );
          })}
          {/* --- Extra: Bulk Jobs quick link --- */}
          {!hasBulk && (
            <>
              <div className="mx-3 my-3 border-t border-slate-200 dark:border-slate-800" />
              <button
                key="bulk"
                type="button"
                onClick={() => onNavigate("bulk")}
                className="w-full text-left"
              >
                <NavLink
                  to="/portal/bulk"
                  title={collapsed ? "Bulk Jobs" : undefined}
                  className={({ isActive }) =>
                    [
                      "group relative mx-2 my-1 flex items-center rounded-lg px-3 py-2 text-sm transition-colors",
                      (isActive || activeKey === "bulk")
                        ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-500/40"
                        : "text-slate-700 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-slate-800",
                      collapsed ? "justify-center" : "justify-start",
                    ].join(" ")
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        aria-hidden
                        className={[
                          "absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r transition-colors",
                          (isActive || activeKey === "bulk") ? "bg-white/90" : "bg-transparent group-hover:bg-emerald-300 dark:group-hover:bg-emerald-600",
                        ].join(" ")}
                      />
                      <span className="shrink-0">
                        <BulkIcon />
                      </span>
                      {!collapsed && <span className="ml-3 font-medium">Bulk Jobs</span>}
                      {collapsed && (
                        <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 rounded-md bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900 text-xs px-2 py-1 opacity-0 group-hover:opacity-100 shadow">
                          Bulk Jobs
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              </button>
            </>
          )}
        </nav>

        {/* Sidebar Footer actions */}
        <div className="border-t border-slate-200 dark:border-slate-800 p-3">
          {collapsed ? (
            /* Collapsed: only the expand button centered */
            <div className="flex items-center justify-center">
              <button
                onClick={() => setCollapsed((v) => !v)}
                className="grid h-10 w-10 place-items-center rounded-full border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <ChevronRightIcon className="h-5 w-5" />
              </button>
            </div>
          ) : (
            /* Expanded: Account card with name + phone, collapse button on the right (like the reference) */
            <div className="relative rounded-xl border border-emerald-200/70 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 pr-12 shadow-sm">
              <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                {uName ?? "—"}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-400 truncate">
                {uPhone ?? ""}
              </div>

              <button
                onClick={() => setCollapsed((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full border border-emerald-200 dark:border-slate-600 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
              >
                <ChevronLeftIcon className="h-5 w-5" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar (mobile + desktop) */}
        <header className="sticky top-0 z-40 h-16 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur">
          <div className="h-full pl-3 sm:pl-4 pr-2 sm:pr-3 relative flex items-center">
            {/* Left: Mobile hamburger (hidden on md+) */}
            <div className="md:hidden">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation"
                className="grid h-10 w-10 place-items-center rounded-full border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 6h16" />
                  <path d="M4 12h16" />
                  <path d="M4 18h16" />
                </svg>
              </button>
            </div>
            {/* Center: Company name brand button */}
            <button
              onClick={onHome}
              title={companyName}
              aria-label={`${companyName} home`}
              className="absolute left-1/2 -translate-x-1/2 min-w-0 flex items-center gap-2 px-1 py-1 rounded-md hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            >
              <span className="text-base sm:text-lg font-extrabold tracking-tight truncate">
                {companyName}
              </span>
            </button>

            {/* Right controls */}
            <div className="ml-auto flex items-center gap-1.5">
              <div
                className="relative"
                onMouseLeave={closeZoom}
              >
                <button
                  type="button"
                  aria-label="Zoom controls"
                  className="grid h-10 w-10 place-items-center rounded-full border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                  onMouseEnter={openZoom}
                  onFocus={openZoom}
                  onBlur={closeZoom}
                  aria-expanded={zoomOpen}
                >
                  <MagnifierIcon className="h-5 w-5" />
                </button>

                {/* Dropdown panel positioned to the LEFT of the button */}
                <div
                  className={[
                    "absolute right-full top-1/2 -translate-y-1/2 mr-2",
                    "flex items-center rounded-full border border-emerald-200 dark:border-slate-700",
                    "bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-sm",
                    "h-10 overflow-hidden transition-all duration-150 ease-out",
                    // collapsed vs open width + padding
                    zoomOpen ? "w-44 px-2 opacity-100 visible translate-x-0 pointer-events-auto" : "w-0 px-0 opacity-0 invisible -translate-x-2 pointer-events-none"
                  ].join(" ")}
                  style={{ transformOrigin: "right center" }}
                  onMouseEnter={openZoom}
                  onMouseLeave={closeZoom}
                >
                  <div className={["flex items-center gap-2 w-full transition-opacity duration-100", zoomOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"].join(" ")}>
                    <button
                      type="button"
                      onClick={zoomOut}
                      className="px-2 py-0.5 text-sm font-semibold rounded-full hover:bg-emerald-50 dark:hover:bg-slate-800"
                      aria-label="Zoom out"
                    >
                      –
                    </button>
                    <input
                      type="range"
                      min={85}
                      max={150}
                      step={5}
                      value={zoom}
                      onChange={(e) => applyZoom(Number(e.target.value))}
                      className="h-2 w-full accent-emerald-600 dark:accent-emerald-400"
                      aria-label="Zoom slider"
                    />
                    <button
                      type="button"
                      onClick={zoomIn}
                      className="px-2 py-0.5 text-sm font-semibold rounded-full hover:bg-emerald-50 dark:hover:bg-slate-800"
                      aria-label="Zoom in"
                    >
                      +
                    </button>
                    <span className="ml-1 text-xs tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">{zoom}%</span>
                  </div>
                </div>
              </div>

              {/* Theme toggle */}
              <button
                onClick={toggleDarkMode}
                className="grid h-10 w-10 place-items-center rounded-full border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                aria-label="Toggle color mode"
                title={darkMode ? "Light mode" : "Dark mode"}
              >
                {darkMode ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
              </button>

              {/* Logout */}
              <button
                onClick={() => {
                  if (window.confirm("Are you sure you want to log out?")) {
                    onLogout();
                    window.location.assign("/login?loggedout=1");
                  }
                }}
                className="grid h-10 w-10 place-items-center rounded-full border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                aria-label="Log out"
                title="Log out"
              >
                <PowerIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        </header>

        {/* Mobile drawer (only on small screens) */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-[60] md:hidden" role="dialog" aria-modal="true">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            {/* Panel */}
            <div className="absolute left-0 top-0 h-full w-72 max-w-[85vw] bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 shadow-xl flex flex-col">
              {/* Drawer header */}
              <div className="flex items-center justify-between h-16 px-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                  {/* <img src="/sla-icon.png" alt="Nathiya Agri" className="h-6 w-auto object-contain" /> */}
                  <span className="text-sm font-semibold truncate">{companyName}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Close navigation"
                  className="grid h-10 w-10 place-items-center rounded-full border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12" />
                    <path d="M18 6l-12 12" />
                  </svg>
                </button>
              </div>

              {/* Drawer nav items */}
              <nav className="flex-1 overflow-y-auto py-2" role="navigation">
                {navItems.map((item) => {
                  const itemTo = resolveTo(item);
                  const isActiveKey = activeKey === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => { onNavigate(item.key); setMobileNavOpen(false); }}
                      className="w-full text-left"
                    >
                      <NavLink
                        to={itemTo}
                        end={itemTo ? itemTo.endsWith("/dashboard") : false}
                        className={({ isActive }) =>
                          [
                            "group relative mx-2 my-1 flex items-center rounded-lg px-3 py-2 text-sm transition-colors",
                            (isActive || isActiveKey)
                              ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-500/40"
                              : "text-slate-700 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-slate-800",
                            "justify-start",
                          ].join(" ")
                        }
                      >
                        <span className="shrink-0">{item.icon ?? defaultIconFor(item.key)}</span>
                        <span className="ml-3 font-medium truncate">{item.label}</span>
                      </NavLink>
                    </button>
                  );
                })}
                {!hasBulk && (
                  <button
                    key="bulk"
                    type="button"
                    onClick={() => { onNavigate("bulk"); setMobileNavOpen(false); }}
                    className="w-full text-left"
                  >
                    <NavLink
                      to="/portal/bulk"
                      className={({ isActive }) =>
                        [
                          "group relative mx-2 my-1 flex items-center rounded-lg px-3 py-2 text-sm transition-colors",
                          (isActive || activeKey === "bulk")
                            ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-500/40"
                            : "text-slate-700 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-slate-800",
                          "justify-start",
                        ].join(" ")
                      }
                    >
                      <span className="shrink-0"><BulkIcon /></span>
                      <span className="ml-3 font-medium truncate">Bulk Jobs</span>
                    </NavLink>
                  </button>
                )}
              </nav>

              {/* Drawer footer */}
              <div className="border-t border-slate-200 dark:border-slate-800 p-3 flex items-center justify-between">
                <button
                  onClick={toggleDarkMode}
                  className="inline-flex items-center gap-2 rounded-md border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                >
                  {darkMode ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
                  <span>Theme</span>
                </button>
                <button
                  onClick={() => {
                    if (window.confirm("Are you sure you want to log out?")) {
                      onLogout();
                      window.location.assign("/login?loggedout=1");
                    }
                  }}
                  className="inline-flex items-center gap-2 rounded-md border border-emerald-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm hover:bg-emerald-50 dark:hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                >
                  <PowerIcon className="h-4 w-4" />
                  <span>Logout</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Content */}
        <main className="flex-1 overflow-auto p-4 sm:p-6 bg-slate-50/60 dark:bg-slate-950">
          {children}
        </main>
      </div>
    </div>
  );
}

/* ---------- Inline SVG Icon Components (no external deps) ---------- */
function IconBase(props: React.SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props} />;
}

function defaultIconFor(key: string) {
  const k = (key || "").toLowerCase();
  if (k.includes("bulk") || k.includes("excel") || k.includes("import")) return <BulkIcon />;
  if (k.includes("lead")) return <UsersIcon />;
  if (k.includes("fetch")) return <RefreshIcon />;
  if (k.includes("overview") || k.includes("dash") || k.includes("home")) return <HomeIcon />;
  return <DotMenuIcon />;
}

function HomeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["h-5 w-5", props.className].filter(Boolean).join(" ")}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10.5V20h14v-9.5" />
    </IconBase>
  );
}

function UsersIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["h-5 w-5", props.className].filter(Boolean).join(" ")}>
    <path d="M16 11a4 4 0 1 0-8 0" />
    <path d="M2 20c0-3.5 4-5 6-5h8c2 0 6 1.5 6 5" />
    <circle cx="12" cy="10" r="3" />
    </IconBase>
  );
}

function RefreshIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["h-5 w-5", props.className].filter(Boolean).join(" ")}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </IconBase>
  );
}


function DotMenuIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["h-5 w-5", props.className].filter(Boolean).join(" ")}>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </IconBase>
  );
}

function BulkIcon(props: React.SVGProps<SVGSVGElement> = {}) {
  return (
    <IconBase {...props} className={["h-5 w-5", props.className].filter(Boolean).join(" ")}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 8h18" />
      <path d="M8 4v14" />
      <path d="M13 12h5" />
      <path d="M13 16h3" />
    </IconBase>
  );
}

function ChevronLeftIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["h-5 w-5", props.className].filter(Boolean).join(" ")}>
      <path d="M15 6l-6 6 6 6" />
    </IconBase>
  );
}
function ChevronRightIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["h-5 w-5", props.className].filter(Boolean).join(" ")}>
      <path d="M9 6l6 6-6 6" />
    </IconBase>
  );
}

function SunIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["", props.className].filter(Boolean).join(" ")}>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </IconBase>
  );
}
function MoonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["", props.className].filter(Boolean).join(" ")}>
      <path d="M21 12.79A9 9 0 0 1 11.21 3 7 7 0 1 0 12 21a9 9 0 0 0 9-8.21z" />
    </IconBase>
  );
}
function PowerIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["", props.className].filter(Boolean).join(" ")}>
      <path d="M12 2v10" />
      <path d="M5.5 7a7 7 0 1 0 13 0" />
    </IconBase>
  );
}
function SearchIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={["", props.className].filter(Boolean).join(" ")}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </IconBase>
  );
}
function MagnifierIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} className={[props.className].filter(Boolean).join(" ")}> 
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
      {/* subtle plus for discoverability */}
      <path d="M11 8.5v5" strokeWidth={1.2} />
      <path d="M8.5 11h5" strokeWidth={1.2} />
    </IconBase>
  );
}