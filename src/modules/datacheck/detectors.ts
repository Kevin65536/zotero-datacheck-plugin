import type { FluentMessageId } from "../../../typings/i10n";

export interface AuditDetectorPreferenceDefinition {
  id: string;
  prefKey: string;
  titleL10nId: FluentMessageId;
  defaultEnabled: boolean;
}

export const AUDIT_DETECTOR_PREFERENCES = [
  {
    id: "duplicate-rows",
    prefKey: "detectorDuplicateRows",
    titleL10nId: "detector-title-duplicate-rows",
    defaultEnabled: true,
  },
  {
    id: "near-duplicate-rows",
    prefKey: "detectorNearDuplicateRows",
    titleL10nId: "detector-title-near-duplicate-rows",
    defaultEnabled: true,
  },
  {
    id: "duplicate-numeric-sequences",
    prefKey: "detectorDuplicateNumericSequences",
    titleL10nId: "detector-title-duplicate-numeric-sequences",
    defaultEnabled: true,
  },
  {
    id: "benford-deviation",
    prefKey: "detectorBenfordDeviation",
    titleL10nId: "detector-title-benford-deviation",
    defaultEnabled: true,
  },
  {
    id: "terminal-digit-preference",
    prefKey: "detectorTerminalDigitPreference",
    titleL10nId: "detector-title-terminal-digit-preference",
    defaultEnabled: true,
  },
  {
    id: "rounding-heaping",
    prefKey: "detectorRoundingHeaping",
    titleL10nId: "detector-title-rounding-heaping",
    defaultEnabled: true,
  },
  {
    id: "p-value-threshold-clustering",
    prefKey: "detectorPValueThresholdClustering",
    titleL10nId: "detector-title-p-value-threshold-clustering",
    defaultEnabled: true,
  },
  {
    id: "repeated-numeric-columns",
    prefKey: "detectorRepeatedNumericColumns",
    titleL10nId: "detector-title-repeated-numeric-columns",
    defaultEnabled: true,
  },
  {
    id: "uniform-numeric-columns",
    prefKey: "detectorUniformNumericColumns",
    titleL10nId: "detector-title-uniform-numeric-columns",
    defaultEnabled: true,
  },
  {
    id: "low-variance-numeric-columns",
    prefKey: "detectorLowVarianceNumericColumns",
    titleL10nId: "detector-title-low-variance-numeric-columns",
    defaultEnabled: true,
  },
  {
    id: "invalid-percentages",
    prefKey: "detectorInvalidPercentages",
    titleL10nId: "detector-title-invalid-percentages",
    defaultEnabled: true,
  },
  {
    id: "invalid-p-values",
    prefKey: "detectorInvalidPValues",
    titleL10nId: "detector-title-invalid-p-values",
    defaultEnabled: true,
  },
] as const;

export type AuditDetectorId =
  (typeof AUDIT_DETECTOR_PREFERENCES)[number]["id"];

export type AuditDetectorPrefKey =
  (typeof AUDIT_DETECTOR_PREFERENCES)[number]["prefKey"];

export function getAuditDetectorPreferenceDefinition(detectorId: string) {
  return AUDIT_DETECTOR_PREFERENCES.find((entry) => entry.id === detectorId);
}