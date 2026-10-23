/**
 * The CMF's own record of each Chilean issuer: material facts (hechos
 * esenciales, which carry every dividend declaration), the dates each
 * quarter's statements are due, the quarter's management discussion
 * (análisis razonado) and its statements (XBRL). It is the regulator's public
 * site, read without a login; Zesty's connector and web app carry none of it.
 *
 * Everything fetched is kept under `.whatsapp/cl/cmf/`: `index.json` holds the
 * lists, `he/<doc>.txt` and `ar/<rut>-<period>.txt` the texts of the PDFs,
 * `eeff/<rut>-<period>.json` the statements' facts, so a document is
 * downloaded once. `scripts/cl/cmf.mts sync` fills it before the
 * analysis; the bundle only reads it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CL_DIR } from "@/lib/cl/config";
import { parseXbrl } from "@/lib/cl/financials";

export const CMF_DIR = join(CL_DIR, "cmf");
export const CMF_INDEX = join(CMF_DIR, "index.json");

/** Ticker → the issuer's RUT (without the check digit) and the registry it is
 *  filed under: banks are in the banking registry, every other issuer in the
 *  securities one. Taken from the CMF's issuer lists on 2026-10-20. A ticker
 *  missing here is reported as "no CMF id", never guessed. */
export const CMF_ISSUER: Record<string, { rut: string; bank?: true }> = {
  "AGUAS-A": { rut: "61808000" }, IAM: { rut: "77274820" },
  "ANDINA-B": { rut: "91144000" },
  CAP: { rut: "91297000" },
  CCU: { rut: "90413000" },
  CENCOSUD: { rut: "93834000" }, CENCOMALLS: { rut: "76433310" },
  CMPC: { rut: "90222000" },
  COLBUN: { rut: "96505760" },
  CONCHATORO: { rut: "90227000" },
  COPEC: { rut: "90690000" },
  ECL: { rut: "88006900" },
  ENELAM: { rut: "94271000" }, ENELCHILE: { rut: "76536353" },
  ENTEL: { rut: "92580000" },
  FALABELLA: { rut: "90749000" },
  FORUS: { rut: "86963200" },
  LTM: { rut: "89862200" },
  MALLPLAZA: { rut: "76017019" },
  NTGCLGAS: { rut: "76609803" },
  PARAUCO: { rut: "94627000" },
  QUINENCO: { rut: "91705000" },
  RIPLEY: { rut: "99579730" },
  SALFACORP: { rut: "96885880" },
  SMU: { rut: "76012676" },
  SONDA: { rut: "83628100" },
  SOQUICOM: { rut: "79768170" },
  AAISA: { rut: "77513781" }, ILC: { rut: "94139000" },
  LIPIGAS: { rut: "96928510" },
  PUCOBRE: { rut: "96561560" }, CAMANCHACA: { rut: "93711000" }, EISA: { rut: "76005049" },
  INGEVEC: { rut: "76016541" }, SCHWAGER: { rut: "96766600" }, ELECMETAL: { rut: "90320000" },
  ENAEX: { rut: "90266000" }, MOLYMET: { rut: "93628000" }, NAVIERA: { rut: "95134000" },
  BESALCO: { rut: "92434000" }, "EMBONOR-B": { rut: "93281000" }, ENELGXCH: { rut: "91081000" },
  EDELMAG: { rut: "88221200" }, TRICOT: { rut: "76266594" }, BANVIDA: { rut: "96882560" },
  "SQM-A": { rut: "93007000" }, "SQM-B": { rut: "93007000" },
  VAPORES: { rut: "90160000" },
  ZOFRI: { rut: "70285500" },
  HABITAT: { rut: "98000100" }, PROVIDA: { rut: "76265736" }, CUPRUM: { rut: "76240079" }, PLANVITAL: { rut: "98001200" },
  CHILE: { rut: "97004000", bank: true }, BCI: { rut: "97006000", bank: true },
  ITAUCL: { rut: "97023000", bank: true }, BSANTANDER: { rut: "97036000", bank: true },
};

export interface CmfNotice {
  /** Filing time as the CMF lists it, "YYYY-MM-DD HH:MM". */
  at: string;
  doc: string;
  /** The CMF's subject category, e.g. "Reparto de utilidades (pago de dividendos)". */
  materia: string;
  /** Path of the notice's text under CMF_DIR, once downloaded. A scan that
   *  OCR could not read has no text: this is then the PDF itself, for a
   *  visual read, and `scanned` is set. */
  text?: string;
  scanned?: true;
  /** The text was read from a scan by OCR: check figures against the PDF
   *  (`he/<doc>.pdf`) before an order rests on them. */
  ocr?: true;
  /** Declares or concerns a dividend, by its subject or its text. Banks file
   *  every notice as "Otros", so only the text tells. */
  dividend?: boolean;
}

/** The dates each period's statements are due (or were filed), as the CMF
 *  lists them: keys "03", "06", "09", "12". */
export type CmfCalendar = Record<string, Partial<Record<"03" | "06" | "09" | "12", string>>>;

export interface CmfReport {
  /** "YYYY-MM", the quarter's closing month. */
  period: string;
  /** Path of the análisis razonado's text under CMF_DIR; null when the CMF
   *  has the statements but no análisis razonado (banks file elsewhere). */
  text: string | null;
}

export interface CmfIssuerRecord {
  rut: string;
  syncedAt: string;
  notices: CmfNotice[];
  calendar: CmfCalendar;
  report: CmfReport | null;
  /** Paths under CMF_DIR of the latest period's statements and of last
   *  December's (`CmfStatements` JSON); null for a bank or when not filed. */
  statements?: string | null;
  december?: string | null;
  /** Why the last sync could not complete, if it could not. */
  error?: string;
}

export type CmfIndex = Record<string, CmfIssuerRecord>;

export function loadCmfIndex(): CmfIndex {
  return existsSync(CMF_INDEX) ? JSON.parse(readFileSync(CMF_INDEX, "utf8")) : {};
}

export function saveCmfIndex(index: CmfIndex) {
  mkdirSync(CMF_DIR, { recursive: true });
  writeFileSync(CMF_INDEX, JSON.stringify(index, null, 1));
}

const DIVIDEND = /dividend|reparto de utilidades/i;

/** Dividend declarations, and the CMF's other dividend subjects. */
export const isDividendNotice = (n: Pick<CmfNotice, "materia" | "dividend">) => n.dividend ?? DIVIDEND.test(n.materia);

// ── Fetching ─────────────────────────────────────────────────────────────────

const BASE = "https://www.cmfchile.cl/institucional/mercados/entidad.php";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

function entityUrl(ticker: string, tab: number): string {
  const i = CMF_ISSUER[ticker];
  const kind = i.bank ? "mercado=B&tipoentidad=BANCO" : "mercado=V&tipoentidad=RVEMI";
  return `${BASE}?${kind}&rut=${i.rut}&vig=VI&control=svs&pestania=${tab}`;
}

async function get(url: string, form?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    method: form ? "POST" : "GET",
    headers: { "User-Agent": UA, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`CMF answered ${res.status} for ${url}`);
  return new TextDecoder("utf-8").decode(await res.arrayBuffer());
}

/** The OCR helper (scripts/cl/ocr.swift, macOS Vision), compiled on first
 *  use (about a minute) and again when its source changes; null where it
 *  cannot be built. */
let ocrBin: string | null | undefined;
function ocr(): string | null {
  if (ocrBin !== undefined) return ocrBin;
  const src = join(process.cwd(), "scripts", "cl", "ocr.swift");
  const bin = join(CMF_DIR, "bin", "ocr");
  try {
    if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
      mkdirSync(join(CMF_DIR, "bin"), { recursive: true });
      execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "ignore", timeout: 300_000 });
    }
    ocrBin = bin;
  } catch {
    ocrBin = null;
  }
  return ocrBin;
}

const hasText = (t: string) => t.replace(/\f/g, "").trim().length >= 40;

/** A PDF the CMF serves and its text: poppler's pdftotext, or the OCR helper
 *  for a scan (`ocr` true). The text is "" for a scan nothing could read. */
async function fetchPdf(url: string): Promise<{ pdf: Buffer; text: string; ocr: boolean }> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`CMF answered ${res.status} for a document`);
  const pdf = Buffer.from(await res.arrayBuffer());
  const tmp = join(tmpdir(), `cmf-${process.pid}-${Date.now()}.pdf`);
  writeFileSync(tmp, pdf);
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 });
  try {
    const text = run("pdftotext", ["-layout", tmp, "-"]);
    if (hasText(text)) return { pdf, text, ocr: false };
    const bin = ocr();
    const read = bin ? run(bin, [tmp]) : "";
    return { pdf, text: hasText(read) ? read : "", ocr: true };
  } finally {
    execFileSync("rm", ["-f", tmp]);
  }
}

const strip = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&oacute;/g, "ó")
    .replace(/&aacute;/g, "á").replace(/&eacute;/g, "é").replace(/&iacute;/g, "í").replace(/&uacute;/g, "ú")
    .replace(/&ntilde;/g, "ñ").replace(/\s+/g, " ").trim();

const dmy = (d: string) => d.split("/").reverse().join("-");

/** Material facts filed between two dates, newest first, with their PDF links. */
async function listNotices(ticker: string, from: Date, to: Date): Promise<(CmfNotice & { url: string | null })[]> {
  const p = (d: Date) => [String(d.getDate()).padStart(2, "0"), String(d.getMonth() + 1).padStart(2, "0"), String(d.getFullYear())];
  const [dd, mm, aa] = p(from);
  const [dd2, mm2, aa2] = p(to);
  const html = await get(entityUrl(ticker, 25), { dd, mm, aa, dd2, mm2, aa2, dias: "", formulario: "1", rut: CMF_ISSUER[ticker].rut });
  const table = html.match(/<table[^>]*>(?:(?!<\/table>)[\s\S])*?Materia[\s\S]*?<\/table>/)?.[0] ?? "";
  const out: (CmfNotice & { url: string | null })[] = [];
  for (const row of table.split(/<\/tr>/i)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 4) continue;
    const when = strip(cells[0]).match(/(\d{2}\/\d{2}\/\d{4}) (\d{2}:\d{2})/);
    if (!when) continue;
    const href = cells[1].match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? null;
    out.push({
      at: `${dmy(when[1])} ${when[2]}`,
      doc: strip(cells[1]),
      materia: strip(cells[3]),
      url: href ? new URL(href, "https://www.cmfchile.cl/").toString() : null,
    });
  }
  return out;
}

async function listCalendar(ticker: string): Promise<CmfCalendar> {
  const text = strip(await get(entityUrl(ticker, 101)));
  const cal: CmfCalendar = {};
  // Rows read "2026 26/05/2026 18/08/2026 17/11/2026 -": a year, then the
  // March, June, September and December dates, "-" where none is set.
  for (const m of text.matchAll(/\b(20\d\d)((?: (?:\d{2}\/\d{2}\/\d{4}|-)){4})/g)) {
    const cells = m[2].trim().split(" ");
    cal[m[1]] = {};
    (["03", "06", "09", "12"] as const).forEach((q, i) => {
      if (cells[i] !== "-") cal[m[1]][q] = dmy(cells[i]);
    });
  }
  return cal;
}

/** The latest period whose statements were due by `today`. */
export function latestFiledPeriod(cal: CmfCalendar, today: string): { year: string; month: string; due: string } | null {
  const done = Object.entries(cal)
    .flatMap(([year, qs]) => Object.entries(qs).map(([month, due]) => ({ year, month, due: due! })))
    .filter((p) => p.due <= today)
    .sort((a, b) => b.due.localeCompare(a.due));
  return done[0] ?? null;
}

/** The next period's due date after `today`. */
export function nextDuePeriod(cal: CmfCalendar, today: string): { year: string; month: string; due: string } | null {
  const next = Object.entries(cal)
    .flatMap(([year, qs]) => Object.entries(qs).map(([month, due]) => ({ year, month, due: due! })))
    .filter((p) => p.due > today)
    .sort((a, b) => a.due.localeCompare(b.due));
  return next[0] ?? null;
}

/** A period's statements page: consolidated first; an issuer without
 *  subsidiaries (ZOFRI, the AFPs) files only individual ones. Kept for the
 *  run, so the análisis razonado and the XBRL come from one request. */
const pages = new Map<string, Promise<{ html: string; tipo: "C" | "I" } | null>>();
function statementsPage(ticker: string, year: string, month: string) {
  const key = `${ticker}|${year}${month}`;
  if (!pages.has(key)) {
    pages.set(key, (async () => {
      for (const tipo of ["C", "I"] as const) {
        const html = await get(entityUrl(ticker, 3), { forma: "P", mm: month, aa: year, tipo, tipo_norma: "IFRS" });
        if (/safec_ifrs_verarchivo/.test(html)) return { html, tipo };
      }
      return null;
    })());
  }
  return pages.get(key)!;
}

const fileLink = (html: string, label: RegExp) => {
  const href = [...html.matchAll(/href="([^"]*safec_ifrs_verarchivo[^"]*)"[^>]*>\s*([^<]*)/gi)].find((m) => label.test(m[2]))?.[1];
  return href ? new URL(href.replace(/&amp;/g, "&"), "https://www.cmfchile.cl/institucional/mercados/").toString() : null;
};

async function fetchReport(ticker: string, year: string, month: string): Promise<CmfReport> {
  const period = `${year}-${month}`;
  const file = join("ar", `${CMF_ISSUER[ticker].rut}-${year}${month}.txt`);
  if (existsSync(join(CMF_DIR, file))) return { period, text: file };
  if (CMF_ISSUER[ticker].bank) return { period, text: null };
  const page = await statementsPage(ticker, year, month);
  const url = page && fileLink(page.html, /^An.lisis Razonado/i);
  if (!url) return { period, text: null };
  const { text } = await fetchPdf(url);
  mkdirSync(join(CMF_DIR, "ar"), { recursive: true });
  writeFileSync(join(CMF_DIR, file), text);
  return { period, text: file };
}

/** A period's statements from its XBRL filing, cached as the facts the
 *  analysis reads (`eeff/<rut>-<period>.json`); null for a bank, or when the
 *  CMF has no XBRL for the period. */
async function fetchStatements(ticker: string, year: string, month: string): Promise<string | null> {
  const file = join("eeff", `${CMF_ISSUER[ticker].rut}-${year}${month}.json`);
  if (existsSync(join(CMF_DIR, file))) return file;
  if (CMF_ISSUER[ticker].bank) return null;
  const page = await statementsPage(ticker, year, month);
  const url = page && fileLink(page.html, /^Estados financieros \(XBRL\)/i);
  if (!url) return null;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`CMF answered ${res.status} for the XBRL`);
  const tmp = join(tmpdir(), `cmf-${process.pid}-${Date.now()}.zip`);
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  try {
    // The instance document is ISO-8859-1.
    const xml = execFileSync("unzip", ["-p", tmp, "*.xbrl"], { encoding: "latin1", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
    mkdirSync(join(CMF_DIR, "eeff"), { recursive: true });
    writeFileSync(join(CMF_DIR, file), JSON.stringify(parseXbrl(xml, `${year}-${month}`, page!.tipo)));
    return file;
  } finally {
    execFileSync("rm", ["-f", tmp]);
  }
}

/**
 * Refresh one issuer: the year's notices with their texts (at most
 * `maxTexts` new downloads a run, newest first; the rest come on the next),
 * the calendar, and the latest quarter's análisis razonado. Every notice is
 * read, not only those filed under a dividend subject: the final dividend
 * comes with the shareholders' meeting's notice, and banks file all of
 * theirs as "Otros".
 */
export async function syncIssuer(
  ticker: string,
  prev: CmfIssuerRecord | undefined,
  today: string,
  { days = 365, maxTexts = 45 } = {}
): Promise<CmfIssuerRecord> {
  const { rut } = CMF_ISSUER[ticker];
  const to = new Date(`${today}T12:00:00`);
  const from = new Date(to.getTime() - days * 86_400_000);
  const known = new Map((prev?.notices ?? []).map((n) => [n.doc, n]));

  const listed = await listNotices(ticker, from, to);
  mkdirSync(join(CMF_DIR, "he"), { recursive: true });
  let downloads = 0;
  const notices: CmfNotice[] = [];
  for (const n of listed) {
    const notice: CmfNotice = known.get(n.doc) ?? { at: n.at, doc: n.doc, materia: n.materia };
    if (!notice.text && n.url && downloads < maxTexts) {
      downloads++;
      const { pdf, text, ocr } = await fetchPdf(n.url);
      if (ocr) writeFileSync(join(CMF_DIR, "he", `${n.doc}.pdf`), pdf);
      if (text) {
        notice.text = join("he", `${n.doc}.txt`);
        writeFileSync(join(CMF_DIR, notice.text), text);
        notice.dividend = DIVIDEND.test(n.materia) || /dividendo/i.test(text);
        if (ocr) notice.ocr = true;
      } else {
        notice.text = join("he", `${n.doc}.pdf`);
        notice.scanned = true;
      }
    }
    notices.push(notice);
  }

  const calendar = await listCalendar(ticker);
  const last = latestFiledPeriod(calendar, today);
  const report = last ? await fetchReport(ticker, last.year, last.month) : null;
  // Twelve months need last December's year too (lib/cl/financials.ts).
  const statements = last ? await fetchStatements(ticker, last.year, last.month) : null;
  const december = last && last.month !== "12" ? await fetchStatements(ticker, String(Number(last.year) - 1), "12") : null;
  return { rut, syncedAt: new Date().toISOString(), notices, calendar, report, statements, december };
}

/** The body of a notice, without the letterhead and the salutation. */
export function noticeBody(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // The first opening that matches, in order: the formula that introduces
  // the fact itself, else the end of the salutation.
  const opening = [
    /lo\s+siguiente\s*:/i,
    /siguiente\s+informaci[oó]n[^:]{0,80}:/i,
    /hecho\s+esencial\s*:/i,
    /consideraci[oó]n\s*:/i,
    /Presente\b/i,
  ].map((re) => flat.match(re)).find((m) => m);
  let body = opening ? flat.slice(opening.index! + opening[0].length).trim() : flat;
  // A salutation is often followed by the legal formula ("De conformidad con
  // el artículo 9…", "El suscrito, en su carácter de…") ending in a colon.
  const formula = body.match(/^(?:De conformidad|De acuerdo|En virtud|En cumplimiento|Conforme|El suscrito|Por medio de la presente|Por la presente)[^:]{0,1000}:/i);
  if (formula) body = body.slice(formula[0].length).trim();
  const end = body.search(/\b(?:Sin otro particular|Saluda(?:mos)? (?:muy )?atentamente|Atentamente,)/i);
  body = (end > 0 ? body.slice(0, end) : body).trim();
  // An opening found in a footer leaves next to nothing: keep the whole text.
  return body.length >= 150 ? body : flat;
}

/** A readable excerpt of an análisis razonado: the layout's runs of spaces
 *  become " · " so its tables stay legible in a line. */
export function reportExcerpt(text: string, chars: number): string {
  const flat = text.split("\n").map((l) => l.trim().replace(/ {3,}/g, " · ")).filter(Boolean).join("\n");
  return flat.length > chars ? flat.slice(0, chars) + "\n…" : flat;
}
