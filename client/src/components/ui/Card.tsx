import React from "react";

export default function Card({ title, subtitle, children, className }: { title?: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-950/70 shadow-sm ${className ?? ""}`}>
      {(title || subtitle) && (
        <header className="p-4 border-b border-slate-200 dark:border-slate-800">
          {title && <h3 className="text-lg font-semibold">{title}</h3>}
          {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}