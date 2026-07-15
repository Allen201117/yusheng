import { summarizeRestorationFeedback } from "../src/lib/restorationMetrics";
import { getRepository } from "../src/lib/storage/repository";

async function main(): Promise<void> {
  try {
    const rows = await getRepository().listRestorationMetricRows();
    const report = summarizeRestorationFeedback(rows);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ error: "report_unavailable" })}\n`);
    process.exitCode = 1;
  }
}

void main();
