/**
 * Health score.
 *
 * Four weighted factors that add up to 100, each one carrying the sentence that
 * explains it and the sentence that says what to do about it. Ported from the
 * SaaS `calculateHealthScoreDetailed`, including both special cases.
 *
 * Differences from the SaaS, on purpose:
 *  - the freshness factor counts staleness, not the SaaS "broken" list, which
 *    had archived and stale cards folded into it. Cards that were never used
 *    and never viewed count too: an unused question nobody ever opened is dead
 *    weight whatever its timestamps say;
 *  - the empty instance gets one explicit factor instead of an empty factor
 *    list, so a report never has to render a bare 100 with nothing under it;
 *  - grades use the plain academic scale (A >= 90 down to F) instead of the
 *    SaaS curve that started A at 85 and used B+/C+ steps. The CLI reports a
 *    raw number next to it, so a curve that flatters the instance would mislead.
 */

import { STALE_DAYS } from "./constants.js";

// Same bands as the hosted MetaLens X-Ray, calibrated on real instances:
// 30 to 50 is typical for a company that has used Metabase for a few years.
const GRADES = [
  [85, "A"],
  [70, "B+"],
  [55, "B"],
  [40, "C+"],
  [30, "C"],
  [20, "D"],
];

/** Letter grade for a 0-100 score. */
function scoreToGrade(score) {
  for (const [floor, grade] of GRADES) if (score >= floor) return grade;
  return "F";
}

/** One-line read on the instance, ported from the SaaS X-Ray verdict. */
function verdictFor(score) {
  if (score >= 90) return "Solid foundation, polish only.";
  if (score >= 70) return "Cleanup project, not a crisis.";
  if (score >= 50) return "Several gaps to close.";
  return "Foundation needs rework.";
}

function finish(factors) {
  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.score, 0)));
  return { score, grade: scoreToGrade(score), verdict: verdictFor(score), factors };
}

/** `{ score, grade, verdict, factors }` for the findings document. */
export function scoreHealth(snapshot, ctx) {
  const totalCards = ctx.activeCards.length;
  const dashboards = ctx.dashboards;
  const duplicates = ctx.duplicates.length;
  const anomalies = ctx.anomalies.length;

  const brokenDashboards = dashboards.filter((d) => d.status === "broken").length;
  const warningDashboards = dashboards.filter((d) => d.status === "warning").length;

  // Nothing saved and nothing published: nothing is broken either.
  if (totalCards === 0 && dashboards.length === 0) {
    return finish([{
      name: "Nothing to grade",
      score: 100,
      maxScore: 100,
      description: "No saved questions and no dashboards, so there is nothing to score yet.",
      howToImprove: "Save a few questions and build a dashboard, then scan again for a real reading.",
    }]);
  }

  // Dashboards but no saved questions: every metric is embedded ad hoc, which
  // is a reusability problem, not a clean instance.
  if (totalCards === 0 && dashboards.length > 0) {
    const dashDeduct = Math.min(
      40,
      Math.round(((brokenDashboards * 3 + warningDashboards) / dashboards.length) * 20),
    );
    return finish([
      {
        name: "Reusable knowledge",
        score: 0,
        maxScore: 60,
        description: `0 saved questions across ${dashboards.length} dashboards, every metric is embedded ad hoc.`,
        howToImprove: "Extract the most-used queries from your dashboards into saved questions. They become reusable, reviewable and documentable.",
      },
      {
        name: "Dashboard reliability",
        score: 40 - dashDeduct,
        maxScore: 40,
        description: `${brokenDashboards} of ${dashboards.length} dashboards have broken cards`,
        howToImprove: dashDeduct > 10
          ? "Fix or remove broken cards from active dashboards, these are what stakeholders see."
          : "Dashboards are in good shape.",
      },
    ]);
  }

  // Never used and never viewed counts as stale: the card exists, nobody reads it.
  const neverUsed = ctx.activeCards.filter((c) => !c.lastUsedAt && (c.viewCount ?? 0) === 0).length;
  const staleCount = ctx.stale.length + neverUsed;
  const staleRatio = staleCount / Math.max(totalCards, 1);
  const staleDeduct = Math.min(35, Math.round(staleRatio * 50));

  const dupDeduct =
    duplicates === 0 ? 0
    : duplicates <= 2 ? 3
    : duplicates <= 5 ? 6
    : duplicates <= 10 ? 12
    : duplicates <= 20 ? 18
    : 25;

  const anomalyDeduct = Math.min(20, anomalies * 4);

  const dashDeduct = dashboards.length > 0
    ? Math.min(20, Math.round(((brokenDashboards * 3 + warningDashboards) / dashboards.length) * 10))
    : 0;

  return finish([
    {
      name: "Content freshness",
      score: 35 - staleDeduct,
      maxScore: 35,
      description: `${staleCount} of ${totalCards} questions are stale or unused (${Math.round(staleRatio * 100)}%)`,
      howToImprove: staleDeduct > 15
        ? `Archive questions not accessed in ${STALE_DAYS}+ days. Start with collections nobody owns.`
        : "Good, most content is actively used.",
    },
    {
      name: "No duplicates",
      score: 25 - dupDeduct,
      maxScore: 25,
      description: duplicates === 0
        ? "No duplicate query groups found"
        : `${duplicates} duplicate group${duplicates === 1 ? "" : "s"} found`,
      howToImprove: duplicates === 0
        ? "No duplicate queries, good discipline."
        : "Consolidate duplicate queries, keep one canonical version per metric.",
    },
    {
      name: "Documentation & organization",
      score: 20 - anomalyDeduct,
      maxScore: 20,
      description: `${anomalies} organizational issue${anomalies === 1 ? "" : "s"} detected`,
      howToImprove: anomalyDeduct > 10
        ? "Add descriptions to top-used questions. Move orphan queries into collections."
        : "Instance is reasonably well organized.",
    },
    {
      name: "Dashboard reliability",
      score: 20 - dashDeduct,
      maxScore: 20,
      description: dashboards.length > 0
        ? `${brokenDashboards} of ${dashboards.length} dashboards have broken cards`
        : "No dashboards analyzed",
      howToImprove: dashDeduct > 5
        ? "Fix or remove broken cards from active dashboards, these are what stakeholders see."
        : "Dashboards are in good shape.",
    },
  ]);
}
