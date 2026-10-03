import type { LocalSmartLookupSettings } from "./types";

/**
 * Merge data.json over defaults. A pre-release local patch stored one `apiKey`;
 * copy it into `embeddingApiKey` and drop the old field so it is not saved back.
 */
export function settingsFromStoredData(
  defaults: LocalSmartLookupSettings,
  data: unknown
): LocalSmartLookupSettings {
  const raw = data && typeof data === "object" ? { ...(data as Record<string, unknown>) } : {};
  const legacy = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  delete raw.apiKey;
  const settings = Object.assign({}, defaults, raw) as LocalSmartLookupSettings;
  if (!settings.embeddingApiKey.trim() && legacy) {
    settings.embeddingApiKey = legacy;
  }
  return settings;
}
