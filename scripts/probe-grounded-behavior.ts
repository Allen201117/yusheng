import { chatComplete } from "../src/lib/llm";
import { runGroundedBehaviorProbe } from "./probe-grounded-behavior-core";

async function main(): Promise<void> {
  const result = await runGroundedBehaviorProbe({
    providerConfigured: Boolean(process.env.SILICONFLOW_API_KEY),
    complete: (messages, signal) => chatComplete(messages, signal),
  });
  console.log(JSON.stringify(result.report, null, 2));
  process.exitCode = result.exitCode;
}

void main().catch(() => {
  console.log(JSON.stringify({
    status: "provider_failed",
    passed: false,
    cases: [{
      id: "probe_bootstrap",
      passed: false,
      error: { category: "provider_unknown", name: "ProviderError" },
    }],
  }, null, 2));
  process.exitCode = 3;
});
