"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import type { AIRecommendation, AnalysisStats } from "@/lib/ai/analyze";

// ── Types ─────────────────────────────────────────────────────────────────────

type ConnectionStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

interface WhatsAppStatus {
  status: ConnectionStatus;
  qrDataUrl: string | null;
  error: string | null;
  groups: { jid: string; name: string; synced_at: number }[];
  totalMessages: number;
}

type GroupSyncStatus = "pending" | "requesting_history" | "waiting" | "done" | "error";

interface GroupProgress {
  jid: string;
  name: string;
  status: GroupSyncStatus;
  messagesReceived: number;
  mediaDownloaded: number;
  page: number;
  error?: string;
}

interface SyncJob {
  id: string;
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
  groups: GroupProgress[];
  backfill?: boolean;
}

type AnalysisState = "idle" | "running" | "done" | "error";

interface PortfolioPosition {
  ticker: string;
  shares: number;
  avg_cost: number | null;
  current_price: number | null;
  market_value: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pc: number | null;
}

interface PortfolioSnapshot {
  date: string;
  total_value: number;
  market_value: number;
  cash_balance: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<string, string> = { BUY: "COMPRAR", SELL: "VENDER", HOLD: "MANTENER" };
const ACTION_BADGE: Record<string, string> = {
  BUY: "bg-[#F5C518] text-[#1a1a1a] border-2 border-[#1a1a1a] font-extrabold",
  SELL: "bg-[#FF4D3D] text-white border-2 border-[#1a1a1a] font-extrabold",
  HOLD: "bg-white text-[#1a1a1a] border-2 border-[#1a1a1a] font-extrabold",
};
const ACTION_BAR: Record<string, string> = { BUY: "bg-[#F5C518]", SELL: "bg-[#FF4D3D]", HOLD: "bg-[#1a1a1a]" };
const ACTION_BORDER: Record<string, string> = {
  BUY: "border-l-[#F5C518]", SELL: "border-l-[#FF4D3D]", HOLD: "border-l-[#1a1a1a]",
};
const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: "Desconectado", connecting: "Conectando…",
  qr_ready: "Escanea el QR", connected: "Conectado",
};
const STATUS_DOT: Record<ConnectionStatus, string> = {
  disconnected: "bg-[#8c959f]", connecting: "bg-[#F5C518] animate-pulse",
  qr_ready: "bg-[#F5C518] animate-pulse", connected: "bg-[#2ECC71]",
};
const GROUP_SYNC_LABEL: Record<GroupSyncStatus, string> = {
  pending: "En cola", requesting_history: "Descargando…",
  waiting: "Esperando entrega…", done: "Completado", error: "Error",
};

function Ma200Badge({ slope }: { slope: number | null | undefined }) {
  if (slope == null) return <span className="text-[#999] text-xs font-bold">—</span>;
  const up = slope >= 0;
  const arrow = up ? "↑" : "↓";
  const color = up ? "text-[#1a9c50]" : "text-[#FF4D3D]";
  return (
    <span className={`text-xs font-mono font-extrabold ${color}`} title="Pendiente MM200 (último mes)">
      {arrow} {Math.abs(slope).toFixed(2)}%
    </span>
  );
}

function elapsed(startedAt: number, completedAt?: number) {
  const ms = (completedAt ?? Date.now()) - startedAt;
  return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
}

// ── Simple markdown renderer ──────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  return text
    .replace(/^### (.+)$/gm, '<h3 class="text-sm font-semibold text-[#1f2328] mt-5 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-base font-semibold text-[#1f2328] mt-6 mb-2 border-b border-[#d0d7de] pb-1">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-lg font-bold text-[#1f2328] mt-4 mb-3">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-[#1f2328] font-semibold">$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="bg-[#f6f8fa] text-emerald-700 px-1 rounded text-xs border border-[#d0d7de]">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 text-[#656d76] text-sm leading-relaxed">• $1</li>')
    .replace(/```json[\s\S]*?```/g, "")
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n\n/g, '</p><p class="text-[#656d76] text-sm leading-relaxed mb-2">')
    .replace(/\n/g, "<br/>");
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  // WhatsApp connection
  const [waStatus, setWaStatus] = useState<WhatsAppStatus>({
    status: "disconnected", qrDataUrl: null, error: null, groups: [], totalMessages: 0,
  });

  // Sync download job
  const [syncSelectedJids, setSyncSelectedJids] = useState<Set<string>>(new Set());
  const [activeJob, setActiveJob] = useState<SyncJob | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // AI analysis (streaming)
  const [analysisState, setAnalysisState] = useState<AnalysisState>("idle");
  const [analysisStats, setAnalysisStats] = useState<AnalysisStats | null>(null);
  const [analysisText, setAnalysisText] = useState("");
  const [aiRecs, setAiRecs] = useState<AIRecommendation[]>([]);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const analysisScrollRef = useRef<HTMLDivElement>(null);

  // Portfolio
  const [portfolio, setPortfolio] = useState<PortfolioPosition[]>([]);
  const [cashBalance, setCashBalanceState] = useState<number | null>(null);
  const [ma200Slopes, setMa200Slopes] = useState<Record<string, number | null>>({});
  const [syncingZesty, setSyncingZesty] = useState(false);
  const [zestySyncError, setZestySyncError] = useState<string | null>(null);
  const [zestySyncSuccess, setZestySyncSuccess] = useState<string | null>(null);

  // Portfolio goal
  const [portfolioGoal, setPortfolioGoalState] = useState<{ amount: number; deadline: string } | null>(null);

  // Portfolio history
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioSnapshot[]>([]);

  // ── Polling ────────────────────────────────────────────────────────────────

  const pollStatus = useCallback(async () => {
    const res = await fetch("/api/whatsapp/status").catch(() => null);
    if (res?.ok) setWaStatus(await res.json());
  }, []);

  useEffect(() => {
    pollStatus();
    const id = setInterval(pollStatus, 2000);
    return () => clearInterval(id);
  }, [pollStatus]);

  const loadSavedRecs = useCallback(async () => {
    const res = await fetch("/api/recommendations").catch(() => null);
    if (res?.ok) { const d = await res.json(); if (d.recommendations?.length) setAiRecs(d.recommendations); }
  }, []);

  useEffect(() => { loadSavedRecs(); }, [loadSavedRecs]);

  useEffect(() => {
    if (waStatus.status === "disconnected") { setSyncSelectedJids(new Set()); }
  }, [waStatus.status]);

  const pollJob = useCallback(async () => {
    const res = await fetch("/api/whatsapp/sync-job").catch(() => null);
    if (!res?.ok) return;
    const data = await res.json();
    setActiveJob(data.job);
    if (data.job?.status !== "running") {
      if (jobPollRef.current) clearInterval(jobPollRef.current);
    }
  }, []);

  useEffect(() => { pollJob(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadPortfolioHistory = useCallback(async () => {
    const res = await fetch("/api/portfolio/history").catch(() => null);
    if (!res?.ok) return;
    const d = await res.json();
    setPortfolioHistory(d.history ?? []);
  }, []);

  const loadPortfolio = useCallback(async () => {
    const res = await fetch("/api/portfolio").catch(() => null);
    if (!res?.ok) return;
    const d = await res.json();
    const positions: PortfolioPosition[] = d.positions ?? [];
    const cash: number | null = d.cash_balance ?? null;
    setPortfolio(positions);
    if (cash != null) setCashBalanceState(cash);
    // Record today's snapshot when we have priced positions
    const marketValue = positions.reduce((sum, p) => sum + (p.market_value ?? 0), 0);
    if (marketValue > 0) {
      const totalValue = marketValue + (cash ?? 0);
      fetch("/api/portfolio/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ total_value: totalValue, market_value: marketValue, cash_balance: cash ?? 0 }),
      })
        .then(() => loadPortfolioHistory())
        .catch(() => null);
    }
  }, [loadPortfolioHistory]);

  const loadMa200 = useCallback(async (tickers: string[]) => {
    if (tickers.length === 0) return;
    const res = await fetch(`/api/ma200?tickers=${tickers.join(",")}`).catch(() => null);
    if (!res?.ok) return;
    const d = await res.json();
    setMa200Slopes((prev) => ({ ...prev, ...(d.slopes ?? {}) }));
  }, []);

  useEffect(() => {
    fetch("/api/portfolio/goal").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.goal) setPortfolioGoalState(d.goal);
    }).catch(() => null);
  }, []);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);
  useEffect(() => { loadPortfolioHistory(); }, [loadPortfolioHistory]);
  useEffect(() => {
    const tickers = portfolio.map((p) => p.ticker);
    if (tickers.length > 0) loadMa200(tickers);
  }, [portfolio, loadMa200]);
  useEffect(() => {
    const tickers = aiRecs.map((r) => r.ticker.toUpperCase());
    if (tickers.length > 0) loadMa200(tickers);
  }, [aiRecs, loadMa200]);

  // Auto-scroll analysis panel
  useEffect(() => {
    if (analysisScrollRef.current) {
      analysisScrollRef.current.scrollTop = analysisScrollRef.current.scrollHeight;
    }
  }, [analysisText]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleConnect() { await fetch("/api/whatsapp/connect", { method: "POST" }); }
  async function handleDisconnect() {
    await fetch("/api/whatsapp/disconnect", { method: "POST" });
    setSyncSelectedJids(new Set()); setActiveJob(null);
    setAnalysisText(""); setAnalysisState("idle"); setAnalysisStats(null);
  }
  async function handleReset() {
    await fetch("/api/whatsapp/reset", { method: "POST" });
    setSyncSelectedJids(new Set()); setActiveJob(null);
    setAnalysisText(""); setAnalysisState("idle"); setAnalysisStats(null);
  }

  function toggleSyncGroup(jid: string) {
    setSyncSelectedJids((prev) => { const n = new Set(prev); n.has(jid) ? n.delete(jid) : n.add(jid); return n; });
  }
  function selectAllSync(selected: boolean) {
    setSyncSelectedJids(selected ? new Set(waStatus.groups.map((g) => g.jid)) : new Set());
  }

  async function handleStartSync(backfill = false) {
    if (syncSelectedJids.size === 0) return;
    const groups = waStatus.groups.filter((g) => syncSelectedJids.has(g.jid)).map((g) => ({ jid: g.jid, name: g.name }));
    const res = await fetch("/api/whatsapp/sync-job", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups, backfill }),
    }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json();
    setActiveJob(data.job);
    if (jobPollRef.current) clearInterval(jobPollRef.current);
    jobPollRef.current = setInterval(pollJob, 2000);
  }

  // ── Portfolio ──────────────────────────────────────────────────────────────

  async function handleSyncZesty() {
    setSyncingZesty(true);
    setZestySyncError(null);
    setZestySyncSuccess(null);
    const res = await fetch("/api/portfolio/sync-zesty", { method: "POST" }).catch(() => null);
    if (!res) { setZestySyncError("Error de red"); setSyncingZesty(false); return; }
    const data = await res.json();
    if (!res.ok || data.error) {
      setZestySyncError(data.error ?? `Error ${res.status}`);
    } else {
      setZestySyncSuccess(`${data.imported} posición${data.imported !== 1 ? "es" : ""} sincronizada${data.imported !== 1 ? "s" : ""} desde Zesty`);
      await loadPortfolio();
      await loadPortfolioHistory();
    }
    setSyncingZesty(false);
  }

  async function handleDeletePosition(ticker: string) {
    const res = await fetch(`/api/portfolio?ticker=${encodeURIComponent(ticker)}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) { await loadPortfolio(); }
  }

  // ── AI Analysis ────────────────────────────────────────────────────────────

  async function handleAnalyze() {
    setAnalysisState("running");
    setAnalysisText("");
    setAiRecs([]);
    setAnalysisError(null);
    setAnalysisStats(null);

    let fullText = "";

    try {
      const response = await fetch("/api/analyze", { method: "POST" });
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const chunk = JSON.parse(line.slice(6));

            if (chunk.type === "stats") {
              setAnalysisStats(chunk.stats);
            } else if (chunk.type === "text") {
              fullText += chunk.content;
              setAnalysisText(fullText);
            } else if (chunk.type === "recommendations") {
              // Structured recommendations now arrive from the server (extracted
              // via a Haiku pass) instead of being parsed from the narrative.
              const recs = chunk.recommendations ?? [];
              setAiRecs(recs);
              if (recs.length > 0) {
                fetch("/api/recommendations", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ recommendations: recs }),
                }).catch(() => null);
              }
            } else if (chunk.type === "done") {
              setAnalysisState("done");
            } else if (chunk.type === "error") {
              setAnalysisError(chunk.error);
              setAnalysisState("error");
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err) {
      setAnalysisError(String(err));
      setAnalysisState("error");
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const isConnected = waStatus.status === "connected";
  const allGroups = waStatus.groups.filter((g) =>
    g.name.toLowerCase().includes("usa trading") || g.name.toLowerCase().includes("crypto dr market") || g.name.toLowerCase().includes("amig@s")
  );
  const jobRunning = activeJob?.status === "running";
  const analysisRunning = analysisState === "running";

  const portfolioTickerSet = new Set(portfolio.map((p) => p.ticker));
  const buyCount = aiRecs.filter((r) => r.action === "BUY").length;
  const sellCount = aiRecs.filter((r) => r.action === "SELL" && portfolioTickerSet.has(r.ticker.toUpperCase())).length;
  const holdCount = aiRecs.filter((r) => r.action === "HOLD" && portfolioTickerSet.has(r.ticker.toUpperCase())).length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#EDE8D5] text-[#1a1a1a] font-sans">
      {/* Header */}
      <header className="bg-[#1a1a1a] sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#F5C518] border-2 border-[#F5C518] flex items-center justify-center text-xl">👽</div>
          <div>
            <h1 className="text-base font-extrabold text-white leading-none tracking-tight uppercase">Dr. Market Stock Picker</h1>
            <p className="text-xs text-[#a0a0a0] mt-0.5 font-semibold">Análisis con IA basado en grupos de WhatsApp</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">

        {/* ── 1. WhatsApp Connection ── */}
        <section className="rounded-2xl border-2 border-[#1a1a1a] bg-white overflow-hidden shadow-[4px_4px_0_#1a1a1a]">
          <div className="px-6 py-5 border-b-2 border-[#1a1a1a] flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT[waStatus.status]}`} />
              <div>
                <h2 className="text-sm font-extrabold text-[#1a1a1a] uppercase tracking-tight">WhatsApp Web</h2>
                <p className="text-xs text-[#666] mt-0.5 font-semibold">
                  {STATUS_LABEL[waStatus.status]}
                  {isConnected && waStatus.totalMessages > 0 &&
                    ` · ${waStatus.totalMessages.toLocaleString()} mensajes almacenados`}
                </p>
              </div>
            </div>
            {isConnected ? (
              <button onClick={handleDisconnect}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-[#1a1a1a] border-2 border-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-white transition-colors">
                Desconectar
              </button>
            ) : (
              <div className="flex items-center gap-2">
                {waStatus.status === "disconnected" && (
                  <button onClick={handleReset}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-[#1a1a1a] border-2 border-[#1a1a1a] hover:bg-[#FF4D3D] hover:text-white hover:border-[#FF4D3D] transition-colors">
                    Resetear credenciales
                  </button>
                )}
                <button onClick={handleConnect}
                  disabled={waStatus.status === "connecting" || waStatus.status === "qr_ready"}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#F5C518] hover:bg-[#e6b800] disabled:opacity-60 disabled:cursor-not-allowed text-[#1a1a1a] text-sm font-extrabold border-2 border-[#1a1a1a] transition-colors shadow-[2px_2px_0_#1a1a1a]">
                  {(waStatus.status === "connecting" || waStatus.status === "qr_ready")
                    ? <><span className="w-3.5 h-3.5 border-2 border-[#1a1a1a]/30 border-t-[#1a1a1a] rounded-full animate-spin" />Conectando…</>
                    : "Conectar WhatsApp"}
                </button>
              </div>
            )}
          </div>
          {waStatus.status === "qr_ready" && waStatus.qrDataUrl && (
            <div className="px-6 py-6 flex flex-col sm:flex-row items-center gap-6">
              <div className="rounded-xl overflow-hidden border-2 border-[#1a1a1a] flex-shrink-0">
                <Image src={waStatus.qrDataUrl} alt="QR" width={192} height={192} unoptimized />
              </div>
              <div>
                <p className="text-sm font-extrabold text-[#1a1a1a] mb-2">Escanea este código desde tu teléfono</p>
                <ol className="text-xs text-[#666] space-y-1.5 list-decimal list-inside font-semibold">
                  <li>Abre WhatsApp en tu teléfono</li>
                  <li>Ve a <span className="text-[#1a1a1a] font-extrabold">Configuración → Dispositivos vinculados</span></li>
                  <li>Toca &quot;Vincular un dispositivo&quot; y escanea el QR</li>
                </ol>
              </div>
            </div>
          )}
          {waStatus.error && (
            <div className="px-6 pb-4">
              <p className="text-xs text-[#1a1a1a] bg-[#F5C518] border-2 border-[#1a1a1a] rounded-lg px-3 py-2 font-bold">{waStatus.error}</p>
            </div>
          )}
        </section>

        {/* ── 2. Download History ── */}
        {isConnected && (
          <section className="rounded-2xl border-2 border-[#1a1a1a] bg-white overflow-hidden shadow-[4px_4px_0_#1a1a1a]">
            <div className="px-6 py-5 border-b-2 border-[#1a1a1a] flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-extrabold text-[#1a1a1a] uppercase tracking-tight">Descargar historial</h2>
                <p className="text-xs text-[#666] mt-0.5 font-semibold">Historial completo · texto, imágenes y archivos</p>
              </div>
              <div className="flex items-center gap-2">
                {!jobRunning && allGroups.length > 0 && (
                  <>
                    <button onClick={() => selectAllSync(true)} className="px-2.5 py-1 rounded-lg text-xs border-2 border-[#1a1a1a] text-[#1a1a1a] font-bold hover:bg-[#1a1a1a] hover:text-white transition-colors">Todos</button>
                    <button onClick={() => selectAllSync(false)} className="px-2.5 py-1 rounded-lg text-xs border-2 border-[#1a1a1a] text-[#1a1a1a] font-bold hover:bg-[#1a1a1a] hover:text-white transition-colors">Ninguno</button>
                  </>
                )}
                <button onClick={() => handleStartSync(true)} disabled={jobRunning || syncSelectedJids.size === 0}
                  title="Re-escanea los últimos 14 días para recuperar mensajes faltantes"
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white hover:bg-[#EDE8D5] disabled:opacity-40 disabled:cursor-not-allowed text-[#1a1a1a] text-sm font-extrabold border-2 border-[#1a1a1a] transition-colors shadow-[2px_2px_0_#1a1a1a]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                  Backfill 14d
                </button>
                <button onClick={() => handleStartSync(false)} disabled={jobRunning || syncSelectedJids.size === 0}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#F5C518] hover:bg-[#e6b800] disabled:opacity-40 disabled:cursor-not-allowed text-[#1a1a1a] text-sm font-extrabold border-2 border-[#1a1a1a] transition-colors shadow-[2px_2px_0_#1a1a1a]">
                  {jobRunning
                    ? <><span className="w-3.5 h-3.5 border-2 border-[#1a1a1a]/30 border-t-[#1a1a1a] rounded-full animate-spin" />Descargando…</>
                    : <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>Descargar {syncSelectedJids.size > 0 ? `(${syncSelectedJids.size})` : ""}</>}
                </button>
              </div>
            </div>
            {!jobRunning && allGroups.length > 0 && (
              <div className="px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {allGroups.map((g) => {
                  const checked = syncSelectedJids.has(g.jid);
                  return (
                    <button key={g.jid} onClick={() => toggleSyncGroup(g.jid)}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left border-2 transition-all ${checked ? "bg-[#F5C518] border-[#1a1a1a]" : "bg-white border-[#1a1a1a] hover:bg-[#EDE8D5]"}`}>
                      <div className={`flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${checked ? "bg-[#1a1a1a] border-[#1a1a1a]" : "border-[#1a1a1a] bg-white"}`}>
                        {checked && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <span className={`text-sm truncate flex-1 min-w-0 font-bold ${checked ? "text-[#1a1a1a]" : "text-[#666]"}`}>{g.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {activeJob && (
              <div className="px-6 pb-5 space-y-3">
                {jobRunning && (
                  <div className="flex items-center gap-2 py-2">
                    <span className="w-3.5 h-3.5 border-2 border-[#EDE8D5] border-t-[#1a1a1a] rounded-full animate-spin flex-shrink-0" />
                    <p className="text-xs text-[#666] font-semibold">{activeJob.backfill ? "Backfill 14d" : "Descargando"} — {elapsed(activeJob.startedAt)} transcurridos</p>
                  </div>
                )}
                {activeJob.status === "done" && (
                  <div className="flex items-center gap-2 py-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-[#F5C518] border-2 border-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                      <svg className="w-2 h-2 text-[#1a1a1a]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    </div>
                    <p className="text-xs text-[#1a1a1a] font-bold">
                      Completado en {elapsed(activeJob.startedAt, activeJob.completedAt)} · {activeJob.groups.reduce((s, g) => s + g.messagesReceived, 0).toLocaleString()} mensajes · {activeJob.groups.reduce((s, g) => s + g.mediaDownloaded, 0).toLocaleString()} archivos
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {activeJob.groups.map((g) => (
                    <div key={g.jid} className={`rounded-xl px-4 py-3 border-2 ${g.status === "done" ? "bg-[#EDE8D5] border-[#1a1a1a]" : g.status === "error" ? "bg-[#FF4D3D]/10 border-[#FF4D3D]" : "bg-white border-[#1a1a1a]"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-extrabold text-[#1a1a1a] truncate flex-1 min-w-0">{g.name}</p>
                        <GroupStatusBadge status={g.status} />
                      </div>
                      {(g.status !== "pending" && g.status !== "error") && (
                        <p className="text-xs text-[#666] mt-1 font-semibold">
                          {g.messagesReceived.toLocaleString()} mensajes · {g.mediaDownloaded.toLocaleString()} archivos
                          {g.status !== "done" && g.page > 0 && <span className="text-[#999]"> · página {g.page}</span>}
                        </p>
                      )}
                      {g.status === "error" && g.error && (
                        <pre className="text-[10px] text-[#FF4D3D] mt-1 font-mono whitespace-pre-wrap break-words max-h-32 overflow-auto">{g.error}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── 3. AI Analysis ── */}
        <section className="rounded-2xl border-2 border-[#1a1a1a] bg-white overflow-hidden shadow-[4px_4px_0_#1a1a1a]">
          <div className="px-6 py-5 border-b-2 border-[#1a1a1a]">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-[#1a1a1a] border-2 border-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-[#F5C518]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <h2 className="text-sm font-extrabold text-[#1a1a1a] uppercase tracking-tight">Análisis con IA</h2>
                <p className="text-xs text-[#666] mt-0.5 font-semibold">
                  {analysisState === "idle" && "Procesa texto, imágenes y PDFs descargados con Claude Opus"}
                  {analysisState === "running" && analysisStats && (
                    `Analizando ${analysisStats.textMessages} mensajes, ${analysisStats.images} imágenes, ${analysisStats.documents} documentos de ${analysisStats.groups.length} grupo(s)…`
                  )}
                  {analysisState === "running" && !analysisStats && "Preparando análisis…"}
                  {analysisState === "done" && `Análisis completado · ${aiRecs.length} recomendaciones generadas`}
                  {analysisState === "error" && "Error en el análisis"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleAnalyze}
                disabled={analysisRunning}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#FF4D3D] hover:bg-[#e63d2d] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-extrabold border-2 border-[#1a1a1a] transition-colors shadow-[2px_2px_0_#1a1a1a]"
              >
                {analysisRunning ? (
                  <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Analizando…</>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Generar recomendaciones IA
                  </>
                )}
              </button>
              {analysisState === "done" && (
                <button onClick={() => { setAnalysisState("idle"); setAnalysisText(""); setAiRecs([]); }}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-[#1a1a1a] border-2 border-[#1a1a1a] hover:bg-[#1a1a1a] hover:text-white transition-colors">
                  Limpiar
                </button>
              )}
            </div>
          </div>

          {/* Analysis stream */}
          {(analysisRunning || analysisState === "done") && analysisText && (
            <div ref={analysisScrollRef}
              className="px-6 py-5 max-h-[520px] overflow-y-auto border-b-2 border-[#1a1a1a] scroll-smooth bg-[#EDE8D5]">
              <div
                className="prose prose-sm max-w-none text-[#444] leading-relaxed"
                dangerouslySetInnerHTML={{ __html: `<p class="text-[#444] text-sm leading-relaxed mb-2">${renderMarkdown(analysisText.replace(/```json[\s\S]*/i, "").trimEnd())}</p>` }}
              />
              {analysisRunning && (
                <span className="inline-block w-2 h-4 bg-[#FF4D3D] animate-pulse rounded-sm ml-0.5" />
              )}
            </div>
          )}

          {/* Empty / idle state */}
          {analysisState === "idle" && (
            <div className="px-6 py-10 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-xl bg-[#F5C518] border-2 border-[#1a1a1a] flex items-center justify-center">
                <svg className="w-6 h-6 text-[#1a1a1a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-extrabold text-[#1a1a1a]">Listo para analizar</p>
                <p className="text-xs text-[#666] mt-1 max-w-xs font-semibold">
                  Haz click en &quot;Generar recomendaciones IA&quot; para procesar todo el contenido descargado con Claude Opus 4.8.
                </p>
              </div>
            </div>
          )}

          {analysisError && (
            <div className="px-6 py-4 border-t-2 border-[#1a1a1a]">
              <p className="text-xs text-white bg-[#FF4D3D] border-2 border-[#1a1a1a] rounded-lg px-3 py-2 font-bold">{analysisError}</p>
            </div>
          )}
        </section>

        {/* ── 4. Portfolio ── */}
        <section className="rounded-2xl border-2 border-[#1a1a1a] bg-white overflow-hidden shadow-[4px_4px_0_#1a1a1a]">
          <div className="px-6 py-5 border-b-2 border-[#1a1a1a]">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-sm font-extrabold text-[#1a1a1a] uppercase tracking-tight">Mi portafolio</h2>
                <p className="text-xs text-[#666] mt-0.5 font-semibold">Posiciones actuales · se comparan con las recomendaciones IA</p>
              </div>
              {cashBalance !== null && (
                <div className="text-right">
                  <p className="text-xs text-[#666] font-semibold">Posición de caja</p>
                  <p className="text-sm font-extrabold text-[#1a1a1a]">
                    ${cashBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
              )}
            </div>
            {portfolioGoal && (() => {
              const totalMktVal = portfolio.reduce((sum, p) => sum + (p.market_value ?? 0), 0);
              const totalValue = totalMktVal + (cashBalance ?? 0);
              const pct = Math.min((totalValue / portfolioGoal.amount) * 100, 100);
              const deadline = new Date(portfolioGoal.deadline + "T00:00:00");
              const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 86400000));
              const remaining = portfolioGoal.amount - totalValue;
              const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <div className="rounded-xl border-2 border-[#1a1a1a] bg-[#EDE8D5] px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="text-xs font-semibold text-[#1f2328]">Meta: ${fmt(portfolioGoal.amount)}</p>
                      <p className="text-xs text-[#656d76]">
                        ${fmt(totalValue)} actual · {daysLeft} días restantes
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-[#1f2328]">{pct.toFixed(1)}%</p>
                      <p className="text-xs text-[#8c959f]">{remaining > 0 ? `$${fmt(remaining)} por llegar` : "¡Meta alcanzada!"}</p>
                    </div>
                  </div>
                  <div className="h-2.5 rounded-full bg-white border border-[#1a1a1a]">
                    <div
                      className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-[#2ECC71]" : "bg-[#F5C518]"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Performance chart */}
          <PortfolioChart history={portfolioHistory} />

          {/* Zesty sync */}
          <div className="px-6 py-4 border-b-2 border-[#1a1a1a] flex items-center gap-3">
            <button onClick={handleSyncZesty} disabled={syncingZesty}
              className="px-4 py-1.5 rounded-lg bg-[#EDE8D5] hover:bg-[#e0dac4] border-2 border-[#1a1a1a] disabled:opacity-40 disabled:cursor-not-allowed text-[#1a1a1a] text-xs font-extrabold transition-colors">
              {syncingZesty ? "Descargando portafolio…" : "Sincronizar desde Zesty"}
            </button>
            {zestySyncError && <p className="text-xs text-[#FF4D3D] font-bold">{zestySyncError}</p>}
            {zestySyncSuccess && <p className="text-xs text-[#1a1a1a] font-bold">{zestySyncSuccess}</p>}
          </div>

          {/* Positions list */}
          {portfolio.length === 0 ? (
            <div className="px-6 py-6">
              <p className="text-xs text-[#666] font-bold">No tienes posiciones aún. Sincroniza desde Zesty para empezar.</p>
            </div>
          ) : (
            <>
            <div className="px-6 py-2 grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto_auto] gap-3 border-b-2 border-[#1a1a1a] bg-[#EDE8D5]">
              <span className="text-xs text-[#666] font-extrabold uppercase">Ticker / Acciones</span>
              <span className="text-xs text-[#666] font-extrabold uppercase text-right w-24">Costo prom.</span>
              <span className="text-xs text-[#666] font-extrabold uppercase text-right w-24">Precio actual</span>
              <span className="text-xs text-[#666] font-extrabold uppercase text-right w-24">Total</span>
              <span className="text-xs text-[#666] font-extrabold uppercase text-right w-16">% Port.</span>
              <span className="text-xs text-[#666] font-extrabold uppercase text-right w-32">P&L</span>
              <span className="text-xs text-[#666] font-extrabold uppercase text-right w-20">MM200</span>
              <span className="text-xs text-[#666] w-24" />
            </div>
            <div className="divide-y-2 divide-[#1a1a1a]/10">
              {(() => {
                const totalMktVal = portfolio.reduce((sum, p) => sum + (p.market_value ?? 0), 0);
                return portfolio.map((pos) => {
                const rec = aiRecs.find((r) => r.ticker.toUpperCase() === pos.ticker);
                const currentPrice = pos.current_price ?? null;
                const total = pos.market_value ?? null;
                const pnl = pos.unrealized_pl ?? null;
                const pnlPct = pos.unrealized_pl_pc != null ? pos.unrealized_pl_pc * 100 : null;
                const portPct = total != null && totalMktVal > 0 ? (total / totalMktVal) * 100 : null;
                const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return (
                  <div key={pos.ticker} className="px-6 py-3 grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto_auto] gap-3 items-center hover:bg-[#EDE8D5] transition-colors">
                    {/* Ticker + shares */}
                    <div className="min-w-0">
                      <span className="font-mono text-sm text-[#1a1a1a]">{pos.ticker}</span>
                      <span className="text-xs text-[#666] ml-2 font-semibold">{pos.shares.toLocaleString()} acc.</span>
                    </div>
                    {/* Avg cost */}
                    <span className="text-xs text-[#666] text-right w-24 font-bold">
                      {pos.avg_cost != null ? `$${fmt(pos.avg_cost)}` : <span className="text-[#999]">—</span>}
                    </span>
                    {/* Current price */}
                    <span className="text-xs text-[#1a1a1a] text-right w-24 font-bold">
                      {currentPrice != null ? `$${fmt(currentPrice)}` : <span className="text-[#999]">—</span>}
                    </span>
                    {/* Total market value */}
                    <span className="text-xs text-[#1a1a1a] text-right w-24 font-bold">
                      {total != null ? `$${fmt(total)}` : <span className="text-[#999]">—</span>}
                    </span>
                    {/* % of portfolio */}
                    <span className="text-xs text-[#666] text-right w-16 font-semibold">
                      {portPct != null ? `${portPct.toFixed(1)}%` : <span className="text-[#999]">—</span>}
                    </span>
                    {/* P&L */}
                    <span className={`text-xs font-extrabold text-right w-32 ${pnl == null ? "" : pnl >= 0 ? "text-[#1a9c50]" : "text-[#FF4D3D]"}`}>
                      {pnl != null
                        ? `${pnl >= 0 ? "+" : ""}$${fmt(pnl)}${pnlPct != null ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : ""}`
                        : <span className="text-[#999]">—</span>}
                    </span>
                    {/* MA200 slope */}
                    <span className="text-right w-20">
                      <Ma200Badge slope={ma200Slopes[pos.ticker]} />
                    </span>
                    {/* Signal + delete */}
                    <div className="flex items-center gap-2 w-24 justify-end flex-shrink-0">
                      {rec ? (
                        <span className={`text-xs px-2 py-0.5 rounded-md ${ACTION_BADGE[rec.action]}`}>
                          {ACTION_LABEL[rec.action]}
                        </span>
                      ) : (
                        <span className="text-xs text-[#999] font-semibold">Sin señal</span>
                      )}
                      <button onClick={() => handleDeletePosition(pos.ticker)}
                        className="text-[#999] hover:text-[#FF4D3D] transition-colors text-lg leading-none font-bold">×</button>
                    </div>
                  </div>
                );
              });
              })()}
            </div>
            </>
          )}

          {/* Recommendations not in portfolio */}
          {aiRecs.length > 0 && (() => {
            const portfolioTickers = new Set(portfolio.map((p) => p.ticker));
            const newOpportunities = aiRecs.filter((r) => !portfolioTickers.has(r.ticker.toUpperCase()) && r.action === "BUY");
            if (newOpportunities.length === 0) return null;
            return (
              <div className="px-6 py-4 border-t-2 border-[#1a1a1a]">
                <p className="text-xs font-extrabold text-[#666] mb-2 uppercase">Oportunidades fuera de tu portafolio</p>
                <div className="flex flex-wrap gap-2">
                  {newOpportunities.map((r, i) => (
                    <span key={`${r.ticker}-${i}`} className="text-xs px-2.5 py-1 rounded-lg bg-[#F5C518] border-2 border-[#1a1a1a] text-[#1a1a1a] font-mono font-extrabold">{r.ticker}</span>
                  ))}
                </div>
              </div>
            );
          })()}
        </section>

        {/* ── 5. Recommendations ── */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-extrabold text-[#1a1a1a] uppercase tracking-tight">Recomendaciones de inversión</h2>
              <p className="text-xs text-[#666] mt-0.5 font-semibold">
                {aiRecs.length > 0
                  ? `${aiRecs.length} recomendaciones generadas por Claude · basadas en texto, imágenes y documentos`
                  : "Genera el análisis IA para ver recomendaciones"}
              </p>
            </div>
            {aiRecs.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-1 rounded-lg bg-[#F5C518] text-[#1a1a1a] border-2 border-[#1a1a1a] font-extrabold">{buyCount} Compra</span>
                <span className="px-2 py-1 rounded-lg bg-[#FF4D3D] text-white border-2 border-[#1a1a1a] font-extrabold">{sellCount} Venta</span>
                <span className="px-2 py-1 rounded-lg bg-white text-[#1a1a1a] border-2 border-[#1a1a1a] font-extrabold">{holdCount} Mantener</span>
              </div>
            )}
          </div>

          {/* AI Recommendations cards */}
          {aiRecs.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {aiRecs.filter((rec) => {
                if (rec.action === "BUY") return true;
                const portfolioTickers = new Set(portfolio.map((p) => p.ticker));
                return portfolioTickers.has(rec.ticker.toUpperCase());
              }).map((rec, i) => (
                <div key={`${rec.ticker}-${i}`} className={`rounded-2xl border-2 border-[#1a1a1a] bg-white overflow-hidden border-l-[6px] shadow-[4px_4px_0_#1a1a1a] ${ACTION_BORDER[rec.action]}`}>
                  <div className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-lg font-extrabold text-[#1a1a1a] font-mono">{rec.ticker}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-lg ${ACTION_BADGE[rec.action]}`}>{ACTION_LABEL[rec.action]}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded-lg bg-[#1a1a1a] text-[#F5C518] border-2 border-[#1a1a1a] font-extrabold">IA</span>
                          <Ma200Badge slope={ma200Slopes[rec.ticker.toUpperCase()]} />
                        </div>
                        <p className="text-xs text-[#666] mt-0.5 font-semibold">
                          {rec.company && <span className="mr-2">{rec.company}</span>}
                          {rec.mentions} menciones
                          {rec.action === "BUY" && rec.entryPrice && ` · Entrada: ${rec.entryPrice}`}
                          {rec.action === "BUY" && rec.priceTarget && ` · Objetivo: ${rec.priceTarget}`}
                          {rec.stopLoss && ` · Stop: ${rec.stopLoss}`}
                        </p>
                      </div>
                      <span className="text-sm font-extrabold text-[#1a1a1a] flex-shrink-0">{rec.confidence}%</span>
                    </div>
                    <div className="mb-3">
                      <div className="h-2 rounded-full bg-[#EDE8D5] border border-[#1a1a1a]">
                        <div className={`h-full rounded-full ${ACTION_BAR[rec.action]}`} style={{ width: `${rec.confidence}%` }} />
                      </div>
                    </div>
                    <div className="rounded-xl bg-[#EDE8D5] border-2 border-[#1a1a1a] px-3 py-2 mb-2">
                      <p className="text-xs text-[#444] leading-relaxed line-clamp-3 font-semibold">{rec.reasoning}</p>
                    </div>
                    {rec.sources?.length > 0 && (
                      <div className="space-y-1">
                        {rec.sources.slice(0, 2).map((s, i) => (
                          <p key={i} className="text-xs text-[#888] italic truncate font-semibold">&ldquo;{s}&rdquo;</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border-2 border-[#1a1a1a] border-dashed bg-white px-6 py-14 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-xl bg-[#EDE8D5] border-2 border-[#1a1a1a] flex items-center justify-center">
                <svg className="w-6 h-6 text-[#666]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-extrabold text-[#1a1a1a]">Sin recomendaciones</p>
                <p className="text-xs text-[#666] mt-1 font-semibold">
                  {"Descarga historial y genera el análisis IA para ver recomendaciones."}
                </p>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PortfolioChart({ history }: { history: PortfolioSnapshot[] }) {
  if (history.length < 2) return null;

  const W = 600;
  const H = 110;
  const PAD = 14;

  const values = history.map((h) => h.total_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const toX = (i: number) => (i / (history.length - 1)) * W;
  const toY = (v: number) => PAD + ((max - v) / range) * (H - PAD * 2);

  const pts = history.map((h, i) => `${toX(i).toFixed(1)},${toY(h.total_value).toFixed(1)}`);
  const linePts = pts.join(" ");
  const areaPts = `0,${H} ${linePts} ${W},${H}`;

  const first = history[0];
  const last = history[history.length - 1];
  const change = last.total_value - first.total_value;
  const changePct = (change / first.total_value) * 100;
  const positive = change >= 0;
  const lineColor = positive ? "#F5C518" : "#FF4D3D";
  const lastX = toX(history.length - 1);
  const lastY = toY(last.total_value);

  const fmt = (n: number) =>
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <div className="px-6 py-4 border-b-2 border-[#1a1a1a]">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <p className="text-xs font-extrabold text-[#666] uppercase mb-0.5">Valor del portafolio</p>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-extrabold text-[#1a1a1a]">{fmt(last.total_value)}</span>
            <span className={`text-xs font-bold ${positive ? "text-[#1a9c50]" : "text-[#FF4D3D]"}`}>
              {positive ? "+" : ""}{fmt(change)} ({positive ? "+" : ""}{changePct.toFixed(1)}%)
            </span>
          </div>
        </div>
        <span className="text-xs text-[#999] font-semibold">{history.length} días registrados</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 90 }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="pgChartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPts} fill="url(#pgChartGrad)" />
        <polyline
          points={linePts}
          fill="none"
          stroke={lineColor}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={lastX} cy={lastY} r="4.5" fill={lineColor} stroke="#1a1a1a" strokeWidth="2" />
      </svg>
      <div className="flex justify-between text-xs text-[#999] font-semibold mt-1">
        <span>{first.date}</span>
        <span className="text-[#666]">
          Mín {fmt(min)} · Máx {fmt(max)}
        </span>
        <span>{last.date}</span>
      </div>
    </div>
  );
}

function GroupStatusBadge({ status }: { status: GroupSyncStatus }) {
  const styles: Record<GroupSyncStatus, string> = {
    pending: "bg-[#EDE8D5] text-[#999] border-2 border-[#1a1a1a]",
    requesting_history: "bg-[#F5C518] text-[#1a1a1a] border-2 border-[#1a1a1a]",
    waiting: "bg-[#F5C518] text-[#1a1a1a] border-2 border-[#1a1a1a]",
    done: "bg-[#1a1a1a] text-white border-2 border-[#1a1a1a]",
    error: "bg-[#FF4D3D] text-white border-2 border-[#1a1a1a]",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-lg flex-shrink-0 font-extrabold ${styles[status]}`}>{GROUP_SYNC_LABEL[status]}</span>;
}
