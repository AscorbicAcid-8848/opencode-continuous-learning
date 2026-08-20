import { readFile } from "node:fs/promises";

import { atomicWriteText } from "../shared/file-io.ts";
import {
  CONFIG_FIELD_SPECS,
  DEFAULT_CONFIG,
  RETIRED_CONFIG_FIELDS,
  type LearningConfig,
  type LearningConfigKey,
} from "./schema.ts";
import { normalizeConfig, validateConfigValue } from "./validate.ts";

export async function loadConfig(path: string): Promise<LearningConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`Unable to read learning config ${path}: ${String(error)}`);
  }
}

export async function updateConfig(
  path: string,
  patch: Partial<LearningConfig>,
): Promise<LearningConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object");
    }
    raw = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Unable to update learning config ${path}: ${String(error)}`,
      );
    }
  }
  for (const key of RETIRED_CONFIG_FIELDS) delete raw[key];
  for (const [rawKey, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELD_SPECS, rawKey)) {
      throw new Error(`Unknown learning config field: ${rawKey}`);
    }
    const key = rawKey as LearningConfigKey;
    raw[key] = validateConfigValue(key, value);
  }
  await atomicWriteText(path, `${JSON.stringify(raw, null, 2)}\n`);
  return normalizeConfig(raw);
}

export async function pruneRetiredConfigFields(path: string): Promise<boolean> {
  let raw: Record<string, unknown>;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object");
    }
    raw = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(
      `Unable to migrate learning config ${path}: ${String(error)}`,
    );
  }
  let changed = false;
  for (const key of RETIRED_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    delete raw[key];
    changed = true;
  }
  if (changed) await atomicWriteText(path, `${JSON.stringify(raw, null, 2)}\n`);
  return changed;
}

export async function resetConfig(path: string): Promise<LearningConfig> {
  return updateConfig(path, DEFAULT_CONFIG);
}

export async function setConfigEnabled(
  path: string,
  enabled: boolean,
): Promise<void> {
  await updateConfig(path, { enabled });
}
