"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { JournalTrade, Origin } from "@/lib/market/trade-journal";

type OriginFilter = "all" | Origin;
type StatusFilter = "all" | "open" | "closed";

const PAGE = 50;

const usd = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = (n: number | null) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
const plClass = (n: number | null) => (n == null ? "text-[#999]" : n > 0 ? "text-[#1a8f3c]" : n < 0 ? "text-[#FF4D3D]" : "text-[#666]");

const ORIGIN_LABEL: Record<Origin | "mixed", string> = { agent: "Agente", user: "Usuario", mixed: "Mixto" };
const STATUS_LABEL: Record<JournalTrade["status"], string> = { open: "Abierto", partial: "Parcial", closed: "Cerrado" };

function OriginBadge({ origin, overridden, onClick }: { origin: Origin | "mixed"; overridden?: boolean; onClick?: () => void }) {
  const cls = origin === "agent" ? "bg-[#F5C518]" : origin === "user" ? "bg-white" : "bg-[#EDE8D5]";
  const body = (
    <>
      {origin === "agent" ? "🤖" : origin === "user" ? "👤" : "↔"} {ORIGIN_LABEL[origin]}
      {overridden && <span title="Marcado a mano">*</span>}
    </>
  );
  const base = `inline-flex items-center gap-1 rounded-full border-2 border-[#1a1a1a] px-2 py-0.5 text-[10px] font-extrabold uppercase whitespace-nowrap ${cls}`;
  return onClick ? (
    <button onClick={onClick} title="Cambiar origen" className={`${base} hover:shadow-[2px_2px_0_#1a1a1a] transition-shadow`}>{body}</button>
  ) : (
    <span className={base}>{body}</span>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number | null }) {
  return (
    <div className="rounded-xl border-2 border-[#1a1a1a] bg-white px-4 py-3">
      <p className="text-[10px] font-extrabold uppercase tracking-wide text-[#666]">{label}</p>
      <p className={`text-lg font-extrabold mt-0.5 tabular-nums ${tone !== undefined ? plClass(tone) : "text-[#1a1a1a]"}`}>{value}</p>
      {sub && <p className="text-[11px] font-semibold text-[#666] mt-0.5">{sub}</p>}
    </div>
  );
}

function summarize(trades: JournalTrade[]) {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.realizedPl > 0).length;
  return {
    count: trades.length,
    closed: closed.length,
    realized: trades.reduce((s, t) => s + t.realizedPl, 0),
    unrealized: trades.reduce((s, t) => s + (t.unrealizedPl ?? 0), 0),
    winRate: closed.length ? (wins / closed.length) * 100 : null,
  };
}

export default function TradeJournal() {
  const [trades, setTrades] = useState<JournalTrade[] | null>(null);
  const [meta, setMeta] = useState<{ unmatchedSells: number; syncedAt: number | null }>({ unmatchedSells: 0, syncedAt: null });
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/trade-journal");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setTrades(j.trades);
      setMeta({ unmatchedSells: j.unmatchedSells, syncedAt: j.syncedAt });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const toggleOrigin = async (t: JournalTrade) => {
    const next: Origin = t.origin === "agent" ? "user" : "agent";
    setTrades((all) => all?.map((x) => (x.id === t.id ? { ...x, origin: next, originOverridden: true } : x)) ?? null);
    await fetch("/api/trade-journal", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, origin: next }),
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (trades ?? []).filter(
      (t) =>
        (origin === "all" || t.origin === origin) &&
        (status === "all" || (status === "closed" ? t.status === "closed" : t.status !== "closed")) &&
        (!q || t.ticker.includes(q))
    );
  }, [trades, origin, status, query]);

  const byOrigin = useMemo(
    () => ({
      agent: summarize((trades ?? []).filter((t) => t.origin === "agent")),
      user: summarize((trades ?? []).filter((t) => t.origin === "user")),
    }),
    [trades]
  );
  const view = summarize(filtered);

  const chip = (active: boolean) =>
    `rounded-full border-2 border-[#1a1a1a] px-3 py-1 text-xs font-extrabold uppercase transition-colors ${active ? "bg-[#1a1a1a] text-white" : "bg-white text-[#1a1a1a] hover:bg-[#EDE8D5]"}`;

  return (
    <div className="min-h-screen bg-[#EDE8D5]">
      <header className="bg-[#1a1a1a] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#F5C518] border-2 border-[#F5C518] flex items-center justify-center text-xl">📒</div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-extrabold text-white leading-none tracking-tight uppercase">Bitácora de trades</h1>
            <p className="text-xs text-[#a0a0a0] mt-0.5 font-semibold">Órdenes ejecutadas en Zesty · neto de comisiones</p>
          </div>
          <Link href="/" className="rounded-xl border-2 border-[#F5C518] px-3 py-1.5 text-xs font-extrabold uppercase text-[#F5C518] hover:bg-[#F5C518] hover:text-[#1a1a1a] transition-colors">
            ← Dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {error && (
          <div className="rounded-xl px-4 py-3 border-2 bg-[#FF4D3D]/10 border-[#FF4D3D] text-sm font-bold">No se pudo cargar la bitácora: {error}</div>
        )}
        {!trades && !error && <p className="text-sm font-bold text-[#666]">Cargando…</p>}

        {trades && (
          <>
            <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(["agent", "user"] as const).map((o) => {
                const s = byOrigin[o];
                return (
                  <div key={o} className="rounded-2xl border-2 border-[#1a1a1a] bg-white p-4 shadow-[4px_4px_0_#1a1a1a]">
                    <div className="flex items-center justify-between mb-3">
                      <OriginBadge origin={o} />
                      <span className="text-xs font-bold text-[#666]">{s.count} trades · {s.closed} cerrados</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Stat label="P&L realizado" value={usd(s.realized)} tone={s.realized} />
                      <Stat label="No realizado" value={usd(s.unrealized)} tone={s.unrealized} />
                      <Stat label="Win rate" value={s.winRate == null ? "—" : `${s.winRate.toFixed(0)}%`} />
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="rounded-2xl border-2 border-[#1a1a1a] bg-white overflow-hidden shadow-[4px_4px_0_#1a1a1a]">
              <div className="px-4 sm:px-6 py-4 border-b-2 border-[#1a1a1a] flex flex-wrap items-center gap-2">
                {(["all", "agent", "user"] as const).map((o) => (
                  <button key={o} className={chip(origin === o)} onClick={() => { setOrigin(o); setShown(PAGE); }}>
                    {o === "all" ? "Todos" : ORIGIN_LABEL[o]}
                  </button>
                ))}
                <span className="w-px h-6 bg-[#1a1a1a] mx-1" />
                {(["all", "open", "closed"] as const).map((s) => (
                  <button key={s} className={chip(status === s)} onClick={() => { setStatus(s); setShown(PAGE); }}>
                    {s === "all" ? "Todos" : s === "open" ? "Abiertos" : "Cerrados"}
                  </button>
                ))}
                <input
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }}
                  placeholder="Ticker"
                  className="ml-auto w-28 rounded-xl border-2 border-[#1a1a1a] px-3 py-1 text-xs font-bold uppercase outline-none focus:bg-[#F5C518]/20"
                />
              </div>
              <div className="px-4 sm:px-6 py-2 border-b-2 border-[#1a1a1a] bg-[#EDE8D5] text-xs font-bold text-[#1a1a1a] flex flex-wrap gap-x-4 gap-y-1">
                <span>{view.count} trades</span>
                <span>Realizado <span className={plClass(view.realized)}>{usd(view.realized)}</span></span>
                <span>No realizado <span className={plClass(view.unrealized)}>{usd(view.unrealized)}</span></span>
                {view.winRate != null && <span>Win rate {view.winRate.toFixed(0)}%</span>}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-[#666] border-b-2 border-[#1a1a1a]">
                      <th className="px-3 py-2 font-extrabold">Ticker</th>
                      <th className="px-3 py-2 font-extrabold">Origen</th>
                      <th className="px-3 py-2 font-extrabold">Compra</th>
                      <th className="px-3 py-2 font-extrabold">Venta</th>
                      <th className="px-3 py-2 font-extrabold text-right">Acciones</th>
                      <th className="px-3 py-2 font-extrabold text-right">P&L</th>
                      <th className="px-3 py-2 font-extrabold text-right">%</th>
                      <th className="px-3 py-2 font-extrabold text-right">Días</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, shown).map((t) => {
                      // An open trade with no last price has nothing to show yet.
                      const pl = t.soldQty === 0 && t.unrealizedPl == null ? null : t.realizedPl + (t.unrealizedPl ?? 0);
                      return (
                        <tr key={t.id} className="border-b border-[#EDE8D5] hover:bg-[#EDE8D5]/50 align-top">
                          <td className="px-3 py-2">
                            <p className="font-extrabold text-sm text-[#1a1a1a]">{t.ticker}</p>
                            <p className="text-[10px] font-bold text-[#666]">{STATUS_LABEL[t.status]}</p>
                            {t.splits.length > 0 && <p className="text-[10px] font-bold text-[#666]" title="Cantidades y precios ajustados al split">split {t.splits.join(", ")}</p>}
                          </td>
                          <td className="px-3 py-2 space-y-1">
                            <OriginBadge origin={t.origin} overridden={t.originOverridden} onClick={() => toggleOrigin(t)} />
                            {t.exitOrigin && t.exitOrigin !== t.origin && (
                              <p className="text-[10px] font-bold text-[#666]">venta: {ORIGIN_LABEL[t.exitOrigin]}</p>
                            )}
                          </td>
                          <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                            <p className="font-bold">{t.entryDate}{t.entryApprox && <span title="Fecha de la orden; pudo ejecutarse después"> ≈</span>}</p>
                            <p className="text-[#666] font-semibold">{price(t.entryPrice)}</p>
                          </td>
                          <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                            <p className="font-bold">{t.exitDate ?? "—"}{t.exitDate && t.exitApprox && <span title="Fecha de la orden; pudo ejecutarse después"> ≈</span>}</p>
                            <p className="text-[#666] font-semibold">{price(t.exitPrice)}{t.exitTypes.some((x) => x.includes("stop")) && " · stop"}</p>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold">
                            {+t.qty.toFixed(4)}
                            {t.status === "partial" && <p className="text-[10px] text-[#666]">vendidas {+t.soldQty.toFixed(4)}</p>}
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums font-extrabold ${plClass(pl)}`}>
                            {pl == null ? "—" : usd(pl)}
                            {t.status !== "closed" && t.unrealizedPl != null && <p className="text-[10px] font-bold text-[#666]">no realizado</p>}
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums font-bold ${plClass(t.plPct)}`}>
                            {t.plPct == null ? "—" : `${t.plPct > 0 ? "+" : ""}${t.plPct.toFixed(1)}%`}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold text-[#666]">{t.holdingDays}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filtered.length > shown && (
                <div className="px-6 py-4 border-t-2 border-[#1a1a1a] text-center">
                  <button className={chip(false)} onClick={() => setShown((n) => n + PAGE)}>
                    Mostrar más ({filtered.length - shown} restantes)
                  </button>
                </div>
              )}
              {filtered.length === 0 && <p className="px-6 py-8 text-center text-sm font-bold text-[#666]">Sin trades con estos filtros.</p>}
            </section>

            <p className="text-[11px] font-semibold text-[#666] leading-relaxed">
              Un trade es una orden de compra; las ventas consumen las compras más antiguas primero (FIFO). P&L neto del 0,30% de comisión por lado.
              <b> Agente</b> = la orden coincide con una compra/venta o stop pedido por un reporte diario de los 3 días previos; todo lo demás es
              <b> Usuario</b>. Haz clic en el origen para corregirlo (*). ≈ = fecha de creación de la orden (stops y GTC pueden ejecutarse después).
              {meta.unmatchedSells > 0 && ` ${meta.unmatchedSells} ventas no tienen compra registrada (anteriores al historial) y no se cuentan.`}
              {meta.syncedAt && ` Órdenes leídas de Zesty: ${new Date(meta.syncedAt * 1000).toLocaleString("es-CL")}.`}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
