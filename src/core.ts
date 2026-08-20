export {
  CONFIG_FIELD_KEYS,
  CONFIG_FIELD_SPECS,
  DEFAULT_CONFIG,
  type ExternalMemoryProviderName,
  type LearningConfig,
  type LearningConfigFieldSpec,
  type LearningConfigKey,
  type MemoryTarget,
  type SkillOwner,
} from "./config/schema.ts";
export { normalizeConfig, validateConfigValue } from "./config/validate.ts";
export {
  loadConfig,
  pruneRetiredConfigFields,
  resetConfig,
  setConfigEnabled,
  updateConfig,
} from "./config/read-write.ts";
export { defaultDataRoot, projectStorageName } from "./config/paths.ts";
export { atomicWriteText } from "./shared/file-io.ts";
export { withStorageLock } from "./shared/lock.ts";
export { LearningStore } from "./store.ts";
export { type SkillProvenance, type SkillSummary } from "./skill/provenance.ts";
export {
  type ReviewCheckpoint,
  type ReviewState,
  ReviewStateStore,
} from "./review/state.ts";
export { type TranscriptItem } from "./review/transcript.ts";
export { countTranscript, isReviewDue } from "./review/schedule.ts";
export { renderTranscript } from "./review/transcript.ts";
export {
  assertSafePersistentText,
  normalizeOneLine,
} from "./safety/text-guard.ts";
