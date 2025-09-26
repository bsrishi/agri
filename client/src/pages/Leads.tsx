import React, { useEffect, useMemo, useRef, useState } from "react";
import Card from "../components/ui/Card";

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const LEADS_URL = `${API_BASE}/api/dashboard/leads`;
const LEADS_GEO_URL = `${API_BASE}/api/dashboard/leads/by-geo`;
const LEADS_LIST_URL = `${API_BASE}/api/dashboard/leads/list`;
const LEADS_FILTERS_URL = `${API_BASE}/api/dashboard/leads/filters`;
const CUSTOMER_SUMMARY_URL = `${API_BASE}/api/customers/summary`;

type CustApp = {
  application_id: string;
  farmer_name?: string;
  mobile?: string;
  aadhaar?: string;
  district?: string; block?: string; village?: string;
  crop_type?: string; mi_name?: string;
  total_area?: number | null; mi_area?: number | null;
  applied_date?: string | null;
  last_status?: string | null; last_status_date?: string | null;
  completed_at?: string | null;
  days_left?: number | null;
  surveys: { survey_no?: string | null; subdivision_no?: string | null }[];
};

type CustomerSummary = {
  ok: boolean;
  key: string;
  applications: CustApp[];
  total_applications: number;
  total_area: number | null;
  total_mi_area: number | null;
  districts: string[]; blocks: string[]; villages: string[];
  crops: string[]; mi_names: string[];
};

type LeadRow = {
  mobile: string;
  applications: number;
  apps_no_status: number;
  apps_in_progress: number;
  apps_final: number;
  apps_rejected: number;
  farmer_names: string[];
  districts: string[];
  blocks: string[];
  villages: string[];
  crops: string[];
  mi_names: string[];
  application_ids: string[];
  last_applied_date?: string | null;
  // Optional arrays if backend supplies them (used to decide eligibility inclusively per customer)
  application_days_remaining?: (number | null)[];
};

type GeoRow = { name: string; applications: number; mobiles: number; total_area: number; mi_area: number };
type DrillRow = { mobile: string; applications: number; total_area: number; mi_area: number; farmer_names: string[]; application_ids: string[] };

export default function Leads() {
  // --- Eligibility helpers (7 years rule) ---
  function parseAppliedDate(s?: string | null): Date | null {
    if (!s) return null;
    const t = String(s).trim();
    // Try DD-MM-YYYY
    const m = t.match(/^([0-9]{2})-([0-9]{2})-([0-9]{4})$/);
    if (m) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      const yy = Number(m[3]);
      const d = new Date(yy, mm - 1, dd, 0, 0, 0, 0);
      return isNaN(d.getTime()) ? null : d;
    }
    // Fallback to Date parser
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }
  function daysUntilSevenYears(applied?: string | null): number | null {
    const d = parseAppliedDate(applied);
    if (!d) return null;
    const sevenYears = new Date(d.getFullYear() + 7, d.getMonth(), d.getDate());
    // Normalize both to local midnight
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const target = new Date(sevenYears.getFullYear(), sevenYears.getMonth(), sevenYears.getDate());
    const ms = target.getTime() - start.getTime();
    return Math.ceil(ms / (1000 * 60 * 60 * 24));
  }
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<LeadRow[]>([]);
  // Derived: filter rows by days eligibility window (7 years rule)
  const eligibleRows = useMemo(() => {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) return rows;

    return rows.filter((r: any) => {
      // Prefer precise backend arrays when present
      if (Array.isArray(r.application_days_remaining) && r.application_days_remaining.length) {
        return r.application_days_remaining.some((rem: any) => rem != null && Number(rem) <= n);
      }
      // Fallback: try last_applied_date (approximate, single-date)
      if (r.last_applied_date) {
        const rem = daysUntilSevenYears(r.last_applied_date);
        return rem !== null && rem <= n;
      }
      // No signals → keep visible to avoid over-filtering
      return true;
    });
  }, [rows, days]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [district, setDistrict] = useState("");
  const [block, setBlock] = useState("");
  const [village, setVillage] = useState("");
  const loadCtl = useRef<AbortController | null>(null);
  const geoCtl = useRef<AbortController | null>(null);
  const filterCtl = useRef<AbortController | null>(null);
  const viewCtl = useRef<AbortController | null>(null);
  const isAbort = (e: any) => e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));

  const [level, setLevel] = useState<'district'|'block'|'village'>('district');
  const [geoRows, setGeoRows] = useState<GeoRow[]>([]);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string|null>(null);

  const visibleGeoRows = useMemo(() => {
    // The backend /by-geo endpoint already applies days (7-year) and geo constraints reliably.
    // Always use geoRows to render the cards. This prevents empty/flicker when per-customer fields are missing.
    return geoRows;
  }, [geoRows]);

  const [drillName, setDrillName] = useState<string>("");
  const [drillRows, setDrillRows] = useState<DrillRow[]>([]);
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState<string|null>(null);

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryData, setSummaryData] = useState<CustomerSummary | null>(null);
  const [summaryMobile, setSummaryMobile] = useState<string | null>(null);

  const [filterDistricts, setFilterDistricts] = useState<string[]>([]);
  const [filterBlocks, setFilterBlocks] = useState<string[]>([]);
  const [filterVillages, setFilterVillages] = useState<string[]>([]);

  async function load(d = days, dist = district, blk = block, vill = village) {
    setError(null);
    setLoading(true);
    if (loadCtl.current) loadCtl.current.abort();
    loadCtl.current = new AbortController();
    const ac = loadCtl.current;
    try {
      const url = new URL(LEADS_URL, window.location.origin);
      // Add 'days' param only if set (>0)
      if (d && Number(d) > 0) url.searchParams.set('days', String(Math.max(1, Number(d))));
      url.searchParams.set('_', String(Date.now()));
      if (dist) url.searchParams.set('district', dist);
      if (blk) url.searchParams.set('block', blk);
      if (vill) url.searchParams.set('village', vill);
      const r = await fetch(url.toString(), {
        method: 'GET', credentials: 'include', signal: ac.signal,
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setRows((j.rows || []).map((row:any) => ({
        ...row,
        districts: Array.isArray(row.districts)
          ? row.districts.filter(Boolean).map((d:string) => d.trim())
          : (row.districts ? [String(row.districts).trim()] : []),
        blocks: Array.isArray(row.blocks)
          ? row.blocks.filter(Boolean).map((d:string) => d.trim())
          : (row.blocks ? [String(row.blocks).trim()] : []),
        villages: Array.isArray(row.villages)
          ? row.villages.filter(Boolean).map((d:string) => d.trim())
          : (row.villages ? [String(row.villages).trim()] : []),
        application_days_remaining: Array.isArray(row.application_days_remaining) ? row.application_days_remaining : undefined,
      })));
    } catch (e: any) {
      if (isAbort(e)) return;
      setError(e?.message || "Load failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadGeo(d = days, lv = level as 'district'|'block'|'village', dist = district, blk = block, vill = village) {
    setGeoError(null);
    setGeoLoading(true);
    if (geoCtl.current) geoCtl.current.abort();
    geoCtl.current = new AbortController();
    const ac = geoCtl.current;
    try {
      const url = new URL(LEADS_GEO_URL, window.location.origin);
      // Add 'days' param only if set (>0)
      if (d && Number(d) > 0) url.searchParams.set('days', String(Math.max(1, Number(d))));
      url.searchParams.set('level', lv);
      if (dist) url.searchParams.set('district', dist);
      if (blk) url.searchParams.set('block', blk);
      if (vill) url.searchParams.set('village', vill);
      url.searchParams.set('_', String(Date.now()));
      const r = await fetch(url.toString(), { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }, signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setGeoRows(j.rows || []);
    } catch (e:any) {
      if (isAbort(e)) return;
      setGeoError(e?.message || 'Load failed');
      setGeoRows([]);
    } finally {
      setGeoLoading(false);
    }
  }

  async function loadDrill(name: string, d = days, lv = level as 'district'|'block'|'village', dist = district, blk = block, vill = village) {
    if (!name) return; // guard against empty geo labels
    setDrillError(null);
    setDrillName(name);
    setDrillOpen(true);        // OPEN the modal immediately for instant feedback
    setDrillLoading(true);     // show loader inside the modal
    try {
      const url = new URL(LEADS_LIST_URL, window.location.origin);
      // Add 'days' param only if set (>0)
      if (d && Number(d) > 0) url.searchParams.set('days', String(Math.max(1, Number(d))));
      url.searchParams.set('level', lv);
      url.searchParams.set('name', name);
      if (dist) url.searchParams.set('district', dist);
      if (blk) url.searchParams.set('block', blk);
      if (vill) url.searchParams.set('village', vill);
      url.searchParams.set('_', String(Date.now()));
      const r = await fetch(url.toString(), { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setDrillRows(j.rows || []);
    } catch (e:any) {
      setDrillError(e?.message || 'Load failed');
      setDrillRows([]);
    } finally {
      setDrillLoading(false);
    }
  }

  // Load dropdown filter options from backend
  async function loadFilters(d = days, dist = district, blk = block, vill = village) {
    try {
      if (filterCtl.current) filterCtl.current.abort();
      filterCtl.current = new AbortController();
      const ac = filterCtl.current;
      const url = new URL(LEADS_FILTERS_URL, window.location.origin);
      // Add 'days' param only if set (>0)
      if (d && Number(d) > 0) url.searchParams.set('days', String(Math.max(1, Number(d))));
      if (dist) url.searchParams.set('district', dist);
      if (blk) url.searchParams.set('block', blk);
      url.searchParams.set('_', String(Date.now()));
      const r = await fetch(url.toString(), { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }, signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const districts: string[] = (j?.filters?.districts || []).map((x:any)=> String(x.name||'').trim()).filter(Boolean);
      const blocks: string[] = (j?.filters?.blocks || []).map((x:any)=> String(x.name||'').trim()).filter(Boolean);
      const villages: string[] = (j?.filters?.villages || []).map((x:any)=> String(x.name||'').trim()).filter(Boolean);
      let dList = [...new Set(districts)].sort((a,b)=>a.localeCompare(b));
      let bList = [...new Set(blocks)].sort((a,b)=>a.localeCompare(b));
      let vList = [...new Set(villages)].sort((a,b)=>a.localeCompare(b));

      // Force lists to stay consistent with current selections
      if (dist && !dList.includes(dist)) { setDistrict(""); }
      if (blk && !bList.includes(blk)) { setBlock(""); }
      if (vill && !vList.includes(vill)) { setVillage(""); }

      setFilterDistricts(dList);
      setFilterBlocks(bList);
      setFilterVillages(vList);
    } catch (e:any) {
      if (isAbort(e)) return;
      setFilterDistricts([]); setFilterBlocks([]); setFilterVillages([]);
    }
  }

  async function openSummaryForMobile(mobile: string) {
    const m10 = (mobile || '').replace(/\D+/g, '').slice(-10);
    if (!m10) return;
    setSummaryError(null);
    setSummaryLoading(true);
    setSummaryOpen(true);
    setSummaryMobile(m10);
    try {
      const url = new URL(CUSTOMER_SUMMARY_URL, window.location.origin);
      url.searchParams.set('mobile', m10); // NOTE: no 'days' here
      const r = await fetch(url.toString(), { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
  
      // NO client-side days filtering here — show all apps in the View modal
      const apps: CustApp[] = Array.isArray(j?.applications) ? j.applications : [];
  
      // Recompute summary totals/facets from ALL apps (unfiltered)
      const totals = apps.reduce((acc, a) => {
        acc.total_applications += 1;
        acc.total_mi_area += Number(a?.mi_area || 0);
        acc.total_area += Number(a?.total_area || 0);
        if (a?.district) acc.districts.add(String(a.district).trim());
        if (a?.block) acc.blocks.add(String(a.block).trim());
        if (a?.village) acc.villages.add(String(a.village).trim());
        return acc;
      }, { total_applications: 0, total_mi_area: 0, total_area: 0,
           districts: new Set<string>(), blocks: new Set<string>(), villages: new Set<string>() });
  
      setSummaryData({
        ok: Boolean(j?.ok),
        key: String(j?.key || m10),
        applications: apps,
        total_applications: totals.total_applications,
        total_area: totals.total_area,
        total_mi_area: totals.total_mi_area,
        districts: Array.from(totals.districts).sort((a,b)=>a.localeCompare(b)),
        blocks:    Array.from(totals.blocks).sort((a,b)=>a.localeCompare(b)),
        villages:  Array.from(totals.villages).sort((a,b)=>a.localeCompare(b)),
        crops: Array.from(new Set(apps.map(a => (a?.crop_type || '').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b)),
        mi_names: Array.from(new Set(apps.map(a => (a?.mi_name || '').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b)),
      } as CustomerSummary);
    } catch (e: any) {
      setSummaryError(e?.message || 'Failed to load customer');
      setSummaryData(null);
    } finally {
      setSummaryLoading(false);
    }
  }

  useEffect(() => {
    // Load all leads and geo data by default (no days param)
    load();
    loadGeo(undefined as any, 'district');
    loadFilters();
    return () => {
      try { loadCtl.current?.abort(); } catch {}
      try { geoCtl.current?.abort(); } catch {}
      try { filterCtl.current?.abort(); } catch {}
      try { viewCtl.current?.abort(); } catch {}
    };
  }, []);

  // Auto-refresh when days/level/filters change (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      load();
      loadGeo(undefined as any, level, district, block, village);
      loadFilters();
    }, 300);
    return () => clearTimeout(t);
  }, [days, level, district, block, village]);

  // derive facet options
  const allDistricts = useMemo(() => {
    const vals = rows.flatMap(r => (r.districts || []).map((d:string) => (d||'').trim()).filter(Boolean));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of vals) { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out.sort((a,b) => a.localeCompare(b));
  }, [rows]);
  const allBlocks = useMemo(() => {
    const vals = rows.flatMap(r => (r.blocks || []).map((d:string) => (d||'').trim()).filter(Boolean));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of vals) { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out.sort((a,b) => a.localeCompare(b));
  }, [rows]);
  const allVillages = useMemo(() => {
    const vals = rows.flatMap(r => (r.villages || []).map((d:string) => (d||'').trim()).filter(Boolean));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of vals) { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out.sort((a,b) => a.localeCompare(b));
  }, [rows]);

  // Filtering is now handled by geo

  return (
    <div className="grid gap-6">
      <Card title="Leads (Sales)">
        {/* Controls */}
        <div className="mb-6 rounded-xl border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/60 dark:bg-slate-900/50 backdrop-blur px-3 sm:px-4 py-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 items-end">
            <div className="sm:mr-2 md:mr-3 lg:mr-4">
              <label className="block text-[12px] mb-1 text-slate-600 dark:text-slate-300">Within (days)</label>
              <div className="flex items-stretch">
                <input
                  type="number" min={1} value={days}
                  onChange={(e) => {
                    const v = Math.max(1, Number(e.target.value) || 1);
                    setDays(v);
                  }}
                  className="w-24 h-10 rounded-l-lg border border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-800/70 backdrop-blur px-3 text-sm text-center shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                />
                <span className="inline-flex items-center h-10 rounded-r-lg border border-l-0 border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-700 px-2 text-sm text-slate-700 dark:text-slate-200">days</span>
              </div>
            </div>
            <div>
              <label className="block text-[12px] mb-1 text-slate-600 dark:text-slate-300">District</label>
              <select
                value={district}
                onChange={e=>{ const v = e.target.value; setDistrict(v); setBlock(""); setVillage(""); setFilterBlocks([]); setFilterVillages([]); load("" as any, v, "", ""); loadGeo(undefined as any, level, v, "", ""); loadFilters(undefined as any, v, "", ""); }}
                className="w-full h-10 md:col-span-1 lg:col-span-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/40"
              >
                <option value="">All Districts</option>
                {filterDistricts.map(d=> <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] mb-1 text-slate-600 dark:text-slate-300">Block</label>
              <select
                value={block}
                onChange={e=>{ const v = e.target.value; setBlock(v); setVillage(""); setFilterVillages([]); load("" as any, district, v, ""); loadGeo(undefined as any, level, district, v, ""); loadFilters(undefined as any, district, v, ""); }}
                className="w-full h-10 md:col-span-1 lg:col-span-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/40"
              >
                <option value="">All Blocks</option>
                {filterBlocks.map(b=> <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] mb-1 text-slate-600 dark:text-slate-300">Village</label>
              <select
                value={village}
                onChange={e=>{ const v = e.target.value; setVillage(v); load("" as any, district, block, v); loadGeo(undefined as any, level, district, block, v); }}
                className="w-full h-10 md:col-span-1 lg:col-span-1 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/40"
              >
                <option value="">All Villages</option>
                {filterVillages.map(v=> <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] mb-1 text-slate-600 dark:text-slate-300">Group by</label>
              <select value={level} onChange={e=>{ const lv = e.target.value as 'district'|'block'|'village'; setLevel(lv); loadGeo(days, lv, district, block, village); }}
                className="w-full h-10 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/40">
                <option value="district">District</option>
                <option value="block">Block</option>
                <option value="village">Village</option>
              </select>
            </div>
            <div className="justify-self-end">
              <button
                type="button"
                onClick={() => {
                  setDistrict("");
                  setBlock("");
                  setVillage("");
                  setFilterBlocks([]);
                  setFilterVillages([]);
                  // On reset, load all leads/geo with no days restriction
                  load();
                  loadGeo(undefined as any, level, "", "", "");
                  loadFilters();
                }}
                className="inline-flex items-center h-10 rounded-lg border border-slate-300 dark:border-slate-600 px-3 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400/40"
              >
                Reset filters
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="rounded-lg border border-rose-300/40 bg-rose-50 dark:border-rose-300/20 dark:bg-rose-500/10 p-3 text-rose-700 dark:text-rose-200 text-sm">{error}</div>
        ) : null}

        <GeoStats rows={visibleGeoRows} leadRows={eligibleRows} loading={geoLoading} level={level} />

        <div className="mt-10">
          <div className="mb-4 text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <span>Potential leads grouped by {level.charAt(0).toUpperCase()+level.slice(1)}</span>
            {geoLoading && <Badge tone="blue">Updating…</Badge>}
          </div>
          {geoError ? (
            <div className="rounded-lg border border-rose-300/40 bg-rose-50 dark:border-rose-300/20 dark:bg-rose-500/10 p-3 text-rose-700 dark:text-rose-200 text-sm">{geoError}</div>
          ) : null}
          {!visibleGeoRows.length && !geoLoading ? (
            <div className="text-sm text-slate-600 dark:text-slate-300">No data for the selected window.</div>
          ) : null}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {visibleGeoRows.map((g) => (
              <div
                key={g.name || '—'}
                role="button"
                tabIndex={0}
                className="group cursor-pointer rounded-xl border border-slate-200/60 dark:border-slate-700/60 bg-white/80 dark:bg-slate-800/70 backdrop-blur p-4 md:p-5 shadow-sm hover:shadow-md transition-[box-shadow,transform] duration-200 min-h-[92px]"
                onClick={() => { if (g.name) loadDrill(g.name, days, level, district, block, village); }}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && g.name) { e.preventDefault(); loadDrill(g.name, days, level, district, block, village); } }}
              >
                <div className="text-xs text-slate-700 dark:text-slate-300 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5">
                  <span
                    className="break-words whitespace-normal mr-2 font-medium"
                    title={g.name || '—'}
                  >
                    {String(g.name || '—').replace(/\s+/g, ' ').trim()}
                  </span>
                  <span className="tabular-nums flex flex-wrap items-center gap-1.5">
                    <Badge tone="blue">{g.applications} Application{g.applications === 1 ? '' : 's'}</Badge>
                    <Badge tone="emerald">{g.mobiles} Contact{g.mobiles === 1 ? '' : 's'}</Badge>
                    <span className="text-[11px] text-slate-500 tabular-nums">MI {g.mi_area.toFixed(2)} / Tot {g.total_area.toFixed(2)} ha</span>
                  </span>
                </div>
                <div className="mt-2 h-2 sm:h-2.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                  <div
                    style={{width: `${Math.min(100, (g.applications / Math.max(1, visibleGeoRows[0]?.applications || 1)) * 100)}%`}}
                    className={`h-full bg-gradient-to-r from-blue-500 to-indigo-500 group-hover:from-blue-600 group-hover:to-indigo-600 ${geoLoading ? '' : 'transition-[width] duration-300'}`}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {drillOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={()=>setDrillOpen(false)}>
          <div className="max-h-[80vh] w-full sm:w-[720px] overflow-auto rounded-t-xl sm:rounded-xl bg-white dark:bg-slate-800 p-4" onClick={(e)=>e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Leads in {level}: {drillName || '—'}</div>
              <button onClick={()=>setDrillOpen(false)} className="inline-flex items-center h-8 rounded-md border border-slate-300 px-2 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400/40">Close</button>
            </div>
            {drillError ? (
              <div className="rounded-lg border border-rose-300/40 bg-rose-50 dark:border-rose-300/20 dark:bg-rose-500/10 p-3 text-rose-700 dark:text-rose-200 text-sm">{drillError}</div>
            ) : null}
            {drillLoading ? (
              <div className="text-sm text-slate-600 dark:text-slate-300">Loading…</div>
            ) : null}
            <ul className="divide-y divide-slate-200 dark:divide-slate-700">
              {drillRows.filter(r => {
                if (!days || days <= 0) return true;
                // Check application_days_remaining array
                if (Array.isArray((r as any).application_days_remaining) && (r as any).application_days_remaining.length) {
                  return (r as any).application_days_remaining.some(
                    (rem: number|null) => rem === null || rem <= days
                  );
                }
                // Fallback: try last_applied_date
                if ((r as any).last_applied_date) {
                  const rem = daysUntilSevenYears((r as any).last_applied_date);
                  return rem === null || rem <= days;
                }
                // No signals → keep visible to avoid over-filtering
                return true;
              }).map((r)=> (
                <li key={r.mobile} className="py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold">{r.mobile}</div>
                      <div className="text-[11px] text-slate-500">{r.applications} Applications · MI {r.mi_area.toFixed(2)} / Tot {r.total_area.toFixed(2)} ha</div>
                    </div>
                    <div className="space-x-2">
                      <button onClick={() => openSummaryForMobile(r.mobile)} className="inline-flex items-center h-8 rounded-md border border-slate-300 px-2 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400/40">View</button>
                      <a href={`tel:${r.mobile}`} className="inline-flex items-center h-8 rounded-md border border-slate-300 px-2 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400/40">Call</a>
                      <a href={`https://wa.me/91${r.mobile}`} target="_blank" rel="noreferrer" className="inline-flex items-center h-8 rounded-md border border-slate-300 px-2 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400/40">WhatsApp</a>
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500 break-all"><span className="font-medium">Applications:</span> {r.application_ids.join(', ')}</div>
                  <div className="mt-2 text-[11px] text-slate-500"><span className="font-medium">Farmers:</span> {r.farmer_names.join(', ') || '—'}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {summaryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="max-h-[90vh] w-[min(1100px,95vw)] overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-4 py-2">
              <div className="text-sm font-semibold">Customer Overview {summaryMobile ? `(+91 ${summaryMobile})` : ''}</div>
              <button onClick={() => { setSummaryOpen(false); setSummaryData(null); }} className="inline-flex items-center h-8 rounded-md border border-slate-300 px-2 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400/40">Close</button>
            </div>
            <div className="p-5 space-y-4 overflow-auto max-h-[78vh]">
              {summaryLoading && <div className="text-sm text-slate-600 dark:text-slate-300">Loading…</div>}
              {summaryError && <div className="text-sm text-rose-700 dark:text-rose-300">{summaryError}</div>}

              {summaryData && (
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap gap-4">
                    <div><span className="font-medium">Applications:</span> {summaryData.total_applications}</div>
                    <div><span className="font-medium">Area (MI/Tot):</span> {(summaryData.total_mi_area||0).toFixed(2)} / {(summaryData.total_area||0).toFixed(2)} ha</div>
                    <div><span className="font-medium">Districts:</span> {summaryData.districts?.join(', ') || '—'}</div>
                    <div><span className="font-medium">Blocks:</span> {summaryData.blocks?.join(', ') || '—'}</div>
                    <div><span className="font-medium">Villages:</span> {summaryData.villages?.join(', ') || '—'}</div>
                  </div>

                  <div className="overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
                    <table className="min-w-full text-xs">
                      <thead className="sticky top-0 z-10 bg-slate-50/95 dark:bg-slate-800/95 backdrop-blur text-slate-600 dark:text-slate-300">
                        <tr>
                          <th className="px-2 py-2 text-left">Application ID</th>
                          <th className="px-2 py-2 text-left">Farmer</th>
                          <th className="px-2 py-2 text-left">District / Block / Village</th>
                          <th className="px-2 py-2 text-left">Crop</th>
                          <th className="px-2 py-2 text-left">MI</th>
                          <th className="px-2 py-2 text-right">MI Area</th>
                          <th className="px-2 py-2 text-right">Total Area</th>
                          <th className="px-2 py-2 text-left">Applied Date</th>
                          <th className="px-2 py-2 text-left">Eligibility (7 yrs)</th>
                          <th className="px-2 py-2 text-left">Surveys</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summaryData.applications?.map((a) => (
                          <tr key={a.application_id} className="border-t border-slate-200 dark:border-slate-700">
                            <td className="px-2 py-2 font-medium">{a.application_id}</td>
                            <td className="px-2 py-2">{a.farmer_name || '—'}</td>
                            <td className="px-2 py-2">{[a.district,a.block,a.village].filter(Boolean).join(' / ') || '—'}</td>
                            <td className="px-2 py-2">{a.crop_type || '—'}</td>
                            <td className="px-2 py-2">{a.mi_name || '—'}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap">{(a.mi_area ?? 0).toFixed(2)}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap">{(a.total_area ?? 0).toFixed(2)}</td>
                            <td className="px-2 py-2">{a.applied_date || '—'}</td>
                            <td className="px-2 py-2">
                              {(() => {
                                const rem = daysUntilSevenYears(a.applied_date);
                                if (rem === null) return '—';
                                if (rem <= 0) return <Badge tone="emerald">Eligible</Badge>;
                                return `Eligible in ${rem} days`;
                              })()}
                            </td>
                            <td className="px-2 py-2">{a.surveys?.length ? a.surveys.map(s => `${s.survey_no || ''}${s.subdivision_no ? ` / ${s.subdivision_no}` : ''}`).join(', ') : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Badge({ children, tone = "slate" }:{ children: React.ReactNode; tone?: "slate"|"amber"|"blue"|"emerald"|"rose" }) {
  const m: Record<string, string> = {
    slate:   "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
    amber:   "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    blue:    "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    rose:    "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 ${m[tone]} border border-black/5`}>{children}</span>;
}
function GeoStats({ rows, leadRows, loading, level }:{ rows: GeoRow[]; leadRows: LeadRow[]; loading: boolean; level: 'district'|'block'|'village' }){
  const totals = React.useMemo(()=>{
    let apps=0, mobiles=0, mi=0, tot=0;
    for (const g of rows){
      apps   += Number(g.applications || 0);
      mobiles+= Number(g.mobiles || 0);
      mi     += Number(g.mi_area || 0);
      tot    += Number(g.total_area || 0);
    }
    return { apps, mobiles, mi, tot };
  }, [rows]);
  return (
    <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div className="rounded-lg border border-slate-200/60 dark:border-slate-700/60 bg-white/60 dark:bg-slate-800/60 backdrop-blur p-4 text-center">
        <div className="text-[11px] text-slate-500">{level[0].toUpperCase()+level.slice(1)}s</div>
        <div className="text-lg font-semibold tabular-nums">{rows.length}</div>
      </div>
      <div className="rounded-lg border border-slate-200/60 dark:border-slate-700/60 bg-white/60 dark:bg-slate-800/60 backdrop-blur p-4 text-center">
        <div className="text-[11px] text-slate-500">Applications</div>
        <div className="text-lg font-semibold tabular-nums">{totals.apps}</div>
      </div>
      <div className="rounded-lg border border-slate-200/60 dark:border-slate-700/60 bg-white/60 dark:bg-slate-800/60 backdrop-blur p-4 text-center">
        <div className="text-[11px] text-slate-500">Contacts</div>
        <div className="text-lg font-semibold tabular-nums">{totals.mobiles}</div>
      </div>
      <div className="rounded-lg border border-slate-200/60 dark:border-slate-700/60 bg-white/60 dark:bg-slate-800/60 backdrop-blur p-4 text-center">
        <div className="text-[11px] text-slate-500">Area (MI / Tot)</div>
        <div className="text-lg font-semibold tabular-nums">{totals.mi.toFixed(2)} / {totals.tot.toFixed(2)}</div>
      </div>
    </div>
  );
}