import type { VoiceObjectStore } from "./storage/voiceObjectStore";
import type { VoiceMeta } from "./storage/types";

export type VoiceSynthesisSource =
  | {
      mode: "preset";
      meta: VoiceMeta;
      presetVoiceId: string;
    }
  | {
      mode: "dynamic";
      meta: VoiceMeta;
      body: Buffer;
    };

export async function resolveVoiceSynthesisSource(
  store: VoiceObjectStore,
  voiceId: string,
  userId: string,
): Promise<VoiceSynthesisSource | null> {
  const meta = await store.getMeta(voiceId, userId);
  if (!meta) return null;
  if (meta.providerVoiceStatus === "deleting") return null;
  if (meta.providerVoiceStatus === "ready" && meta.providerVoiceId) {
    return {
      mode: "preset",
      meta,
      presetVoiceId: meta.providerVoiceId,
    };
  }

  const voice = await store.get(voiceId, userId);
  if (!voice) return null;
  return { mode: "dynamic", meta: voice.meta, body: voice.body };
}
