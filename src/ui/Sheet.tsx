import type { ReactNode } from "react";

/** Hoja inferior táctil (se cierra tocando fuera). */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" onPointerDown={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative max-h-[78dvh] overflow-y-auto rounded-t-3xl bg-slate-900/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-white shadow-2xl backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="h-11 w-11 rounded-full bg-white/10 text-xl active:scale-95" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Toggle({ label, desc, on, onChange }: { label: string; desc?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className="flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl bg-white/5 px-4 py-2 text-left active:bg-white/10"
      onClick={() => onChange(!on)}
    >
      <span>
        <span className="block font-semibold">{label}</span>
        {desc && <span className="block text-xs text-white/60">{desc}</span>}
      </span>
      <span className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? "bg-emerald-500" : "bg-white/20"}`}>
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}
