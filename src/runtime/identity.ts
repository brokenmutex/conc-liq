import { z } from "zod";

const identitySchema = z.object({
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  nodeVersion: z.string().min(1),
}).strict();
export type RuntimeIdentity = z.infer<typeof identitySchema>;

export function loadRuntimeIdentity(): RuntimeIdentity | undefined {
  const raw = process.env.CONC_LIQ_RUNTIME_IDENTITY;
  return raw === undefined ? undefined : identitySchema.parse(JSON.parse(raw));
}

export function assertRuntimeMatches(stored: RuntimeIdentity | null, current?: RuntimeIdentity): void {
  if (!stored || !current || stored.buildId !== current.buildId ||
    stored.configHash !== current.configHash || stored.nodeVersion !== current.nodeVersion) {
    throw new Error("Paper session runtime differs or is unrecorded; use its pinned release and configuration");
  }
}
