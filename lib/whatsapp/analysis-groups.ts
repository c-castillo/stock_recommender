/**
 * The groups the analysis is allowed to read — declared here, not clicked.
 *
 * `wa_groups.selected` is what getContentForAnalysis actually filters on, and
 * it lives in the database. That made scope drift silently: refreshGroups()
 * enumerates every chat in the account, so with the old `DEFAULT 1` every
 * family, work and tennis group joined the corpus. A session would report
 * "content is thin" after being fed 29 soccer messages and 5 from the real
 * trading channel.
 *
 * Pinning it in code makes scope declarative and self-healing: the list is
 * reapplied every time the database opens, so a resync, a restored backup or a
 * hand-edited row can never widen what the analyst sees.
 *
 * Entries match a group's name or its JID. Override without editing code by
 * setting ANALYSIS_GROUPS to a comma-separated list. Set ANALYSIS_GROUPS="" to
 * fall back to manual selection in the dashboard.
 */

export const PINNED_ANALYSIS_GROUPS: string[] = [
  "👽 Dr. Market 🇺🇸 USA Trading",
  // Named like a social group, but it is the larger source of real US-equity
  // analysis: the CIEN/INFN pair trade, the GLW anti-short call, the broker
  // PDFs and sector screens all came from here rather than from USA Trading.
  "Amig@s Imaginari@s",
];

/** The pinned set, honouring the ANALYSIS_GROUPS override. */
export function pinnedAnalysisGroups(): string[] {
  const env = process.env.ANALYSIS_GROUPS;
  if (env === undefined) return PINNED_ANALYSIS_GROUPS;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Groups whose message-level noise may be pruned from the database.
 *
 * Everything NOT listed here is exempt, so the safe default is "never delete".
 * 👽 Dr. Market 🇺🇸 USA Trading is deliberately absent: it is 100% on-topic, so
 * there is nothing to gain from pruning it and a misclassification there would
 * destroy signal that cannot be re-fetched.
 */
export const PRUNABLE_GROUPS: string[] = [
  // Genuinely mixed: mostly useful analysis, with social chatter in between.
  "Amig@s Imaginari@s",
];
