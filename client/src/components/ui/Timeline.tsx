import React from "react";
import Badge from "./Badge";

export default function Timeline({ items }: { items: Array<{ status_date?: string; status?: string; remarks?: string; name?: string }> }) {
  if (!items?.length) return <p className="text-sm text-slate-500 dark:text-slate-400">No timeline.</p>;
  return (
    <ol className="relative border-l border-slate-200 dark:border-slate-800 ml-3">
      {items.map((it, idx) => (
        <li key={idx} className="mb-4 ml-4">
          <span className="absolute -left-1.5 h-3 w-3 bg-slate-300 dark:bg-slate-700 rounded-full" />
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{it.status_date}</span>
              <Badge tone="info">{it.status}</Badge>
            </div>
            {it.remarks && <p className="text-sm">{it.remarks}</p>}
            {it.name && <p className="text-xs text-slate-400">By {it.name}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}