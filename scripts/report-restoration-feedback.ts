import { summarizeRestorationFeedback } from "../src/lib/restorationMetrics";
import { listRestorationMetricRowsForReport } from "../src/lib/restorationReportDataSource";

async function main(): Promise<void> {
  try {
    const rows = await listRestorationMetricRowsForReport();
    const report = summarizeRestorationFeedback(rows);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ error: "report_unavailable" })}\n`);
    process.exitCode = 1;
  }
}

void main();
