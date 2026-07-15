import { runRestorationReportCommand } from "../src/lib/restorationReportCommand";

async function main(): Promise<void> {
  const result = await runRestorationReportCommand();
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}

void main();
