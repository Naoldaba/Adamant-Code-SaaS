function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export function Table({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">{children}</div>;
}

export function TableInner({ children }: { children: React.ReactNode }) {
  return <table className="min-w-full text-sm">{children}</table>;
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cx("text-left font-medium text-slate-600 px-3 py-2 border-b bg-slate-50", className)}>{children}</th>;
}

export function Td({ children, className, colSpan }: { children: React.ReactNode; className?: string; colSpan?: number }) {
  return <td className={cx("px-3 py-2 border-b", className)} colSpan={colSpan}>{children}</td>;
}
