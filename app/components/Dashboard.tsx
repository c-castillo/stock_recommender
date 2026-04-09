"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";

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
}

// AI-generated recommendations (rich, streaming / persisted)
interface AIRecommendation {
  ticker: string;
  company: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entryPrice: string | null;
  priceTarget: string | null;
  stopLoss: string | null;
  reasoning: string;
  mentions: number;
  sources: string[];
  generatedAt?: number;
}

interface AnalysisStats {
  textMessages: number;
  images: number;
  documents: number;
  groups: string[];
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

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<string, string> = { BUY: "COMPRAR", SELL: "VENDER", HOLD: "MANTENER" };
const ACTION_BADGE: Record<string, string> = {
  BUY: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  SELL: "bg-red-50 text-red-700 border border-red-200",
  HOLD: "bg-amber-50 text-amber-700 border border-amber-200",
};
const ACTION_BAR: Record<string, string> = { BUY: "bg-emerald-500", SELL: "bg-red-500", HOLD: "bg-amber-500" };
const ACTION_BORDER: Record<string, string> = {
  BUY: "border-l-emerald-500", SELL: "border-l-red-500", HOLD: "border-l-amber-500",
};
const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: "Desconectado", connecting: "Conectando…",
  qr_ready: "Escanea el QR", connected: "Conectado",
};
const STATUS_DOT: Record<ConnectionStatus, string> = {
  disconnected: "bg-[#8c959f]", connecting: "bg-amber-400 animate-pulse",
  qr_ready: "bg-amber-400 animate-pulse", connected: "bg-emerald-500",
};
const GROUP_SYNC_LABEL: Record<GroupSyncStatus, string> = {
  pending: "En cola", requesting_history: "Descargando…",
  waiting: "Esperando entrega…", done: "Completado", error: "Error",
};

function Ma200Badge({ slope }: { slope: number | null | undefined }) {
  if (slope == null) return <span className="text-[#8c959f] text-xs">—</span>;
  const up = slope >= 0;
  const arrow = up ? "↑" : "↓";
  const color = up ? "text-emerald-600" : "text-red-600";
  return (
    <span className={`text-xs font-mono font-semibold ${color}`} title="Pendiente MM200 (último mes)">
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

  const loadPortfolio = useCallback(async () => {
    const res = await fetch("/api/portfolio").catch(() => null);
    if (!res?.ok) return;
    const d = await res.json();
    setPortfolio(d.positions ?? []);
    if (d.cash_balance != null) setCashBalanceState(d.cash_balance);
  }, []);

  const loadMa200 = useCallback(async (tickers: string[]) => {
    if (tickers.length === 0) return;
    const res = await fetch(`/api/ma200?tickers=${tickers.join(",")}`).catch(() => null);
    if (!res?.ok) return;
    const d = await res.json();
    setMa200Slopes((prev) => ({ ...prev, ...(d.slopes ?? {}) }));
  }, []);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);
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

  function toggleSyncGroup(jid: string) {
    setSyncSelectedJids((prev) => { const n = new Set(prev); n.has(jid) ? n.delete(jid) : n.add(jid); return n; });
  }
  function selectAllSync(selected: boolean) {
    setSyncSelectedJids(selected ? new Set(waStatus.groups.map((g) => g.jid)) : new Set());
  }

  async function handleStartSync() {
    if (syncSelectedJids.size === 0) return;
    const groups = waStatus.groups.filter((g) => syncSelectedJids.has(g.jid)).map((g) => ({ jid: g.jid, name: g.name }));
    const res = await fetch("/api/whatsapp/sync-job", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups }),
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
            } else if (chunk.type === "done") {
              // Extract structured recommendations from the full text
              const recs = extractRecommendations(fullText);
              setAiRecs(recs);
              setAnalysisState("done");
              if (recs.length > 0) {
                fetch("/api/recommendations", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ recommendations: recs }),
                }).catch(() => null);
              }
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

  function extractRecommendations(text: string): AIRecommendation[] {
    const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
    if (matches.length === 0) return [];
    try {
      const parsed = JSON.parse(matches[matches.length - 1][1].trim());
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (r) => typeof r.ticker === "string" && ["BUY", "SELL", "HOLD"].includes(r.action)
      );
    } catch { return []; }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const isConnected = waStatus.status === "connected";
  const allGroups = waStatus.groups.filter((g) =>
    g.name.toLowerCase().includes("usa trading") || g.name.toLowerCase().includes("crypto dr market") || g.name.toLowerCase().includes("amig@s")
  );
  const jobRunning = activeJob?.status === "running";
  const analysisRunning = analysisState === "running";

  const buyCount = aiRecs.filter((r) => r.action === "BUY").length;
  const sellCount = aiRecs.filter((r) => r.action === "SELL").length;
  const holdCount = aiRecs.filter((r) => r.action === "HOLD").length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#f6f8fa] text-[#1f2328] font-sans">
      {/* Header */}
      <header className="border-b border-[#d0d7de] bg-white/90 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#f6f8fa] border border-[#d0d7de] flex items-center justify-center text-xl">👽</div>
          <div>
            <h1 className="text-base font-semibold text-[#1f2328] leading-none">Dr. Market Stock Picker</h1>
            <p className="text-xs text-[#656d76] mt-0.5">Análisis con IA basado en grupos de WhatsApp</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">

        {/* ── 1. WhatsApp Connection ── */}
        <section className="rounded-2xl border border-[#d0d7de] bg-white overflow-hidden">
          <div className="px-6 py-5 border-b border-[#d0d7de] flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT[waStatus.status]}`} />
              <div>
                <h2 className="text-sm font-semibold text-[#1f2328]">WhatsApp Web</h2>
                <p className="text-xs text-[#656d76] mt-0.5">
                  {STATUS_LABEL[waStatus.status]}
                  {isConnected && waStatus.totalMessages > 0 &&
                    ` · ${waStatus.totalMessages.toLocaleString()} mensajes almacenados`}
                </p>
              </div>
            </div>
            {isConnected ? (
              <button onClick={handleDisconnect}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-[#656d76] border border-[#d0d7de] hover:border-[#8c959f] hover:text-[#1f2328] transition-colors">
                Desconectar
              </button>
            ) : (
              <button onClick={handleConnect}
                disabled={waStatus.status === "connecting" || waStatus.status === "qr_ready"}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
                {(waStatus.status === "connecting" || waStatus.status === "qr_ready")
                  ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Conectando…</>
                  : "Conectar WhatsApp"}
              </button>
            )}
          </div>
          {waStatus.status === "qr_ready" && waStatus.qrDataUrl && (
            <div className="px-6 py-6 flex flex-col sm:flex-row items-center gap-6">
              <div className="rounded-xl overflow-hidden border border-[#d0d7de] flex-shrink-0">
                <Image src={waStatus.qrDataUrl} alt="QR" width={192} height={192} unoptimized />
              </div>
              <div>
                <p className="text-sm font-medium text-[#1f2328] mb-2">Escanea este código desde tu teléfono</p>
                <ol className="text-xs text-[#656d76] space-y-1.5 list-decimal list-inside">
                  <li>Abre WhatsApp en tu teléfono</li>
                  <li>Ve a <span className="text-[#1f2328] font-medium">Configuración → Dispositivos vinculados</span></li>
                  <li>Toca &quot;Vincular un dispositivo&quot; y escanea el QR</li>
                </ol>
              </div>
            </div>
          )}
          {waStatus.error && (
            <div className="px-6 pb-4">
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{waStatus.error}</p>
            </div>
          )}
        </section>

        {/* ── 2. Download History ── */}
        {isConnected && (
          <section className="rounded-2xl border border-[#d0d7de] bg-white overflow-hidden">
            <div className="px-6 py-5 border-b border-[#d0d7de] flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-[#1f2328]">Descargar historial</h2>
                <p className="text-xs text-[#656d76] mt-0.5">Historial completo · texto, imágenes y archivos</p>
              </div>
              <div className="flex items-center gap-2">
                {!jobRunning && allGroups.length > 0 && (
                  <>
                    <button onClick={() => selectAllSync(true)} className="px-2.5 py-1 rounded-md text-xs border border-[#d0d7de] text-[#656d76] hover:text-[#1f2328] hover:border-[#8c959f] transition-colors">Todos</button>
                    <button onClick={() => selectAllSync(false)} className="px-2.5 py-1 rounded-md text-xs border border-[#d0d7de] text-[#656d76] hover:text-[#1f2328] hover:border-[#8c959f] transition-colors">Ninguno</button>
                  </>
                )}
                <button onClick={handleStartSync} disabled={jobRunning || syncSelectedJids.size === 0}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
                  {jobRunning
                    ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Descargando…</>
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
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left border transition-all ${checked ? "bg-emerald-50 border-emerald-300 hover:bg-emerald-100" : "bg-white border-[#d0d7de] hover:bg-[#f6f8fa]"}`}>
                      <div className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${checked ? "bg-emerald-600 border-emerald-600" : "border-[#d0d7de] bg-white"}`}>
                        {checked && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <span className={`text-sm truncate flex-1 min-w-0 ${checked ? "text-[#1f2328] font-medium" : "text-[#656d76]"}`}>{g.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {activeJob && (
              <div className="px-6 pb-5 space-y-3">
                {jobRunning && (
                  <div className="flex items-center gap-2 py-2">
                    <span className="w-3.5 h-3.5 border-2 border-[#d0d7de] border-t-emerald-600 rounded-full animate-spin flex-shrink-0" />
                    <p className="text-xs text-[#656d76]">Descargando — {elapsed(activeJob.startedAt)} transcurridos</p>
                  </div>
                )}
                {activeJob.status === "done" && (
                  <div className="flex items-center gap-2 py-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-emerald-600 flex items-center justify-center flex-shrink-0">
                      <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    </div>
                    <p className="text-xs text-emerald-700">
                      Completado en {elapsed(activeJob.startedAt, activeJob.completedAt)} · {activeJob.groups.reduce((s, g) => s + g.messagesReceived, 0).toLocaleString()} mensajes · {activeJob.groups.reduce((s, g) => s + g.mediaDownloaded, 0).toLocaleString()} archivos
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {activeJob.groups.map((g) => (
                    <div key={g.jid} className={`rounded-xl px-4 py-3 border ${g.status === "done" ? "bg-[#f6f8fa] border-[#d0d7de]" : g.status === "error" ? "bg-red-50 border-red-200" : "bg-white border-[#d0d7de]"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-medium text-[#1f2328] truncate flex-1 min-w-0">{g.name}</p>
                        <GroupStatusBadge status={g.status} />
                      </div>
                      {(g.status !== "pending" && g.status !== "error") && (
                        <p className="text-xs text-[#656d76] mt-1">
                          {g.messagesReceived.toLocaleString()} mensajes · {g.mediaDownloaded.toLocaleString()} archivos
                          {g.status !== "done" && g.page > 0 && <span className="text-[#8c959f]"> · página {g.page}</span>}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── 3. AI Analysis ── */}
        <section className="rounded-2xl border border-[#d0d7de] bg-white overflow-hidden">
          <div className="px-6 py-5 border-b border-[#d0d7de]">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[#1f2328]">Análisis con IA</h2>
                <p className="text-xs text-[#656d76] mt-0.5">
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
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors shadow-sm"
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
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-[#656d76] border border-[#d0d7de] hover:border-[#8c959f] hover:text-[#1f2328] transition-colors">
                  Limpiar
                </button>
              )}
            </div>
          </div>

          {/* Analysis stream */}
          {(analysisRunning || analysisState === "done") && analysisText && (
            <div ref={analysisScrollRef}
              className="px-6 py-5 max-h-[520px] overflow-y-auto border-b border-[#d0d7de] scroll-smooth bg-[#f6f8fa]">
              <div
                className="prose prose-sm max-w-none text-[#656d76] leading-relaxed"
                dangerouslySetInnerHTML={{ __html: `<p class="text-[#656d76] text-sm leading-relaxed mb-2">${renderMarkdown(analysisText.replace(/```json[\s\S]*/i, "").trimEnd())}</p>` }}
              />
              {analysisRunning && (
                <span className="inline-block w-2 h-4 bg-violet-500 animate-pulse rounded-sm ml-0.5" />
              )}
            </div>
          )}

          {/* Empty / idle state */}
          {analysisState === "idle" && (
            <div className="px-6 py-10 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-violet-50 border border-violet-200 flex items-center justify-center">
                <svg className="w-6 h-6 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-[#1f2328]">Listo para analizar</p>
                <p className="text-xs text-[#8c959f] mt-1 max-w-xs">
                  Haz click en &quot;Generar recomendaciones IA&quot; para procesar todo el contenido descargado con Claude Opus 4.6.
                </p>
              </div>
            </div>
          )}

          {analysisError && (
            <div className="px-6 py-4 border-t border-[#d0d7de]">
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{analysisError}</p>
            </div>
          )}
        </section>

        {/* ── 4. Portfolio ── */}
        <section className="rounded-2xl border border-[#d0d7de] bg-white overflow-hidden">
          <div className="px-6 py-5 border-b border-[#d0d7de] flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[#1f2328]">Mi portafolio</h2>
              <p className="text-xs text-[#656d76] mt-0.5">Posiciones actuales · se comparan con las recomendaciones IA</p>
            </div>
            {cashBalance !== null && (
              <div className="text-right">
                <p className="text-xs text-[#656d76]">Posición de caja</p>
                <p className="text-sm font-semibold text-emerald-700">
                  ${cashBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
            )}
          </div>

          {/* Zesty sync */}
          <div className="px-6 py-4 border-b border-[#d0d7de] flex items-center gap-3">
            <button onClick={handleSyncZesty} disabled={syncingZesty}
              className="px-4 py-1.5 rounded-lg bg-[#f6f8fa] hover:bg-[#eaeef2] border border-[#d0d7de] disabled:opacity-40 disabled:cursor-not-allowed text-[#24292f] text-xs font-medium transition-colors">
              {syncingZesty ? "Descargando portafolio…" : "Sincronizar desde Zesty"}
            </button>
            {zestySyncError && <p className="text-xs text-red-700">{zestySyncError}</p>}
            {zestySyncSuccess && <p className="text-xs text-emerald-700">{zestySyncSuccess}</p>}
          </div>

          {/* Positions list */}
          {portfolio.length === 0 ? (
            <div className="px-6 py-6">
              <p className="text-xs text-[#8c959f]">No tienes posiciones aún. Sincroniza desde Zesty para empezar.</p>
            </div>
          ) : (
            <>
            <div className="px-6 py-2 grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto] gap-3 border-b border-[#d0d7de]/60 bg-[#f6f8fa]">
              <span className="text-xs text-[#8c959f]">Ticker / Acciones</span>
              <span className="text-xs text-[#8c959f] text-right w-24">Costo prom.</span>
              <span className="text-xs text-[#8c959f] text-right w-24">Precio actual</span>
              <span className="text-xs text-[#8c959f] text-right w-24">Total</span>
              <span className="text-xs text-[#8c959f] text-right w-32">P&L</span>
              <span className="text-xs text-[#8c959f] text-right w-20">MM200</span>
              <span className="text-xs text-[#8c959f] w-24" />
            </div>
            <div className="divide-y divide-[#d0d7de]/60">
              {portfolio.map((pos) => {
                const rec = aiRecs.find((r) => r.ticker.toUpperCase() === pos.ticker);
                const currentPrice = pos.current_price ?? null;
                const total = pos.market_value ?? null;
                const pnl = pos.unrealized_pl ?? null;
                const pnlPct = pos.unrealized_pl_pc != null ? pos.unrealized_pl_pc * 100 : null;
                const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return (
                  <div key={pos.ticker} className="px-6 py-3 grid grid-cols-[1fr_auto_auto_auto_auto_auto_auto] gap-3 items-center hover:bg-[#f6f8fa] transition-colors">
                    {/* Ticker + shares */}
                    <div className="min-w-0">
                      <span className="font-mono text-sm font-bold text-[#1f2328]">{pos.ticker}</span>
                      <span className="text-xs text-[#656d76] ml-2">{pos.shares.toLocaleString()} acc.</span>
                    </div>
                    {/* Avg cost */}
                    <span className="text-xs text-[#656d76] text-right w-24">
                      {pos.avg_cost != null ? `$${fmt(pos.avg_cost)}` : <span className="text-[#8c959f]">—</span>}
                    </span>
                    {/* Current price */}
                    <span className="text-xs text-[#1f2328] text-right w-24">
                      {currentPrice != null ? `$${fmt(currentPrice)}` : <span className="text-[#8c959f]">—</span>}
                    </span>
                    {/* Total market value */}
                    <span className="text-xs text-[#1f2328] text-right w-24">
                      {total != null ? `$${fmt(total)}` : <span className="text-[#8c959f]">—</span>}
                    </span>
                    {/* P&L */}
                    <span className={`text-xs font-medium text-right w-32 ${pnl == null ? "" : pnl >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                      {pnl != null
                        ? `${pnl >= 0 ? "+" : ""}$${fmt(pnl)}${pnlPct != null ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : ""}`
                        : <span className="text-[#8c959f]">—</span>}
                    </span>
                    {/* MA200 slope */}
                    <span className="text-right w-20">
                      <Ma200Badge slope={ma200Slopes[pos.ticker]} />
                    </span>
                    {/* Signal + delete */}
                    <div className="flex items-center gap-2 w-24 justify-end flex-shrink-0">
                      {rec ? (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${ACTION_BADGE[rec.action]}`}>
                          {ACTION_LABEL[rec.action]}
                        </span>
                      ) : (
                        <span className="text-xs text-[#8c959f]">Sin señal</span>
                      )}
                      <button onClick={() => handleDeletePosition(pos.ticker)}
                        className="text-[#8c959f] hover:text-red-600 transition-colors text-lg leading-none">×</button>
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}

          {/* Recommendations not in portfolio */}
          {aiRecs.length > 0 && (() => {
            const portfolioTickers = new Set(portfolio.map((p) => p.ticker));
            const newOpportunities = aiRecs.filter((r) => !portfolioTickers.has(r.ticker.toUpperCase()) && r.action === "BUY");
            if (newOpportunities.length === 0) return null;
            return (
              <div className="px-6 py-4 border-t border-[#d0d7de]">
                <p className="text-xs font-medium text-[#656d76] mb-2">Oportunidades fuera de tu portafolio</p>
                <div className="flex flex-wrap gap-2">
                  {newOpportunities.map((r) => (
                    <span key={r.ticker} className="text-xs px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 font-mono font-semibold">{r.ticker}</span>
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
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-zinc-100">Recomendaciones de inversión</h2>
                {aiRecs.length > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">IA</span>
                )}
              </div>
              <p className="text-xs text-[#656d76] mt-0.5">
                {aiRecs.length > 0
                  ? `${aiRecs.length} recomendaciones generadas por Claude · basadas en texto, imágenes y documentos`
                  : "Genera el análisis IA para ver recomendaciones"}
              </p>
            </div>
            {aiRecs.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">{buyCount} Compra</span>
                <span className="px-2 py-1 rounded-md bg-red-50 text-red-700 border border-red-200">{sellCount} Venta</span>
                <span className="px-2 py-1 rounded-md bg-amber-50 text-amber-700 border border-amber-200">{holdCount} Mantener</span>
              </div>
            )}
          </div>

          {/* AI Recommendations cards */}
          {aiRecs.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {aiRecs.map((rec) => (
                <div key={rec.ticker} className={`rounded-2xl border border-[#d0d7de] bg-white overflow-hidden border-l-4 ${ACTION_BORDER[rec.action]}`}>
                  <div className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-lg font-bold text-[#1f2328] font-mono">{rec.ticker}</span>
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${ACTION_BADGE[rec.action]}`}>{ACTION_LABEL[rec.action]}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">IA</span>
                          <Ma200Badge slope={ma200Slopes[rec.ticker.toUpperCase()]} />
                        </div>
                        <p className="text-xs text-[#656d76] mt-0.5">
                          {rec.company && <span className="mr-2">{rec.company}</span>}
                          {rec.mentions} menciones
                          {rec.action === "BUY" && rec.entryPrice && ` · Entrada: ${rec.entryPrice}`}
                          {rec.action === "BUY" && rec.priceTarget && ` · Objetivo: ${rec.priceTarget}`}
                          {rec.stopLoss && ` · Stop: ${rec.stopLoss}`}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-[#1f2328] flex-shrink-0">{rec.confidence}%</span>
                    </div>
                    <div className="mb-3">
                      <div className="h-1.5 rounded-full bg-[#eaeef2]">
                        <div className={`h-full rounded-full ${ACTION_BAR[rec.action]}`} style={{ width: `${rec.confidence}%` }} />
                      </div>
                    </div>
                    <div className="rounded-lg bg-[#f6f8fa] border border-[#d0d7de] px-3 py-2 mb-2">
                      <p className="text-xs text-[#656d76] leading-relaxed line-clamp-3">{rec.reasoning}</p>
                    </div>
                    {rec.sources?.length > 0 && (
                      <div className="space-y-1">
                        {rec.sources.slice(0, 2).map((s, i) => (
                          <p key={i} className="text-xs text-[#8c959f] italic truncate">&ldquo;{s}&rdquo;</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-[#d0d7de] border-dashed bg-white px-6 py-14 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-[#f6f8fa] border border-[#d0d7de] flex items-center justify-center">
                <svg className="w-6 h-6 text-[#8c959f]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-[#1f2328]">Sin recomendaciones</p>
                <p className="text-xs text-[#8c959f] mt-1">
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

function GroupStatusBadge({ status }: { status: GroupSyncStatus }) {
  const styles: Record<GroupSyncStatus, string> = {
    pending: "bg-[#f6f8fa] text-[#8c959f] border border-[#d0d7de]",
    requesting_history: "bg-amber-50 text-amber-700 border border-amber-200",
    waiting: "bg-amber-50 text-amber-700 border border-amber-200",
    done: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    error: "bg-red-50 text-red-700 border border-red-200",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-md flex-shrink-0 ${styles[status]}`}>{GROUP_SYNC_LABEL[status]}</span>;
}
