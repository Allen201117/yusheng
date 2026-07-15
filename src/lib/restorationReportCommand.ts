import { summarizeRestorationFeedback } from "./restorationMetrics";
import { listRestorationMetricRowsForReport } from "./restorationReportDataSource";
import type { RestorationMetricRow } from "./storage/types";

export async function runRestorationReportCommand(
  loadRows: () => Promise<RestorationMetricRow[]> = listRestorationMetricRowsForReport,
): Promise<{ stdout: string; exitCode: 0 | 1 }> {
  try {
    const report = summarizeRestorationFeedback(await loadRows());
    return {
      stdout: `${JSON.stringify(report, null, 2)}\n`,
      exitCode: 0,
    };
  } catch {
    return {
      stdout: `${JSON.stringify({ error: "report_unavailable" })}\n`,
      exitCode: 1,
    };
  }
}
