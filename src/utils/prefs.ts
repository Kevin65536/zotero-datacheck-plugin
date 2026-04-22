import { config } from "../../package.json";
import {
  AUDIT_DETECTOR_PREFERENCES,
  type AuditDetectorId,
} from "../modules/datacheck/detectors";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear preference value.
 * Wrapper of `Zotero.Prefs.clear`.
 * @param key
 */
export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

export function isDataCheckEnabled() {
  return Boolean(getPref("enable"));
}

export function getEnabledAuditDetectorIds(): AuditDetectorId[] {
  return AUDIT_DETECTOR_PREFERENCES.filter((entry) => {
    const value = getPref(entry.prefKey as keyof PluginPrefsMap);
    return typeof value === "boolean" ? value : entry.defaultEnabled;
  }).map((entry) => entry.id);
}
