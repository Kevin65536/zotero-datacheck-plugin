import { config } from "../../package.json";
import { AUDIT_DETECTOR_PREFERENCES } from "./datacheck/detectors";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";

const PREFS_ROOT_ID = `${config.addonRef}-prefs-root`;

export async function registerPrefsScripts(window: Window) {
  renderPrefsUI(window);
}

function renderPrefsUI(window: Window) {
  const doc = window.document;
  const root = doc.getElementById(PREFS_ROOT_ID);
  if (!root) {
    return;
  }

  root.replaceChildren();

  const enableCard = doc.createElement("section");
  enableCard.className = "dc-pref-card";
  const enableLabel = doc.createElement("label");
  enableLabel.className = "dc-pref-toggle";
  const enableInput = doc.createElement("input");
  enableInput.type = "checkbox";
  enableInput.checked = Boolean(getPref("enable"));
  const enableText = doc.createElement("span");
  enableText.className = "dc-pref-toggle-text";
  const enableTitle = doc.createElement("strong");
  enableTitle.textContent = getString("prefs-enable-label");
  const enableDetail = doc.createElement("span");
  enableDetail.className = "dc-pref-detail";
  enableDetail.textContent = getString("prefs-enable-detail");
  enableText.append(enableTitle, enableDetail);
  enableLabel.append(enableInput, enableText);
  enableCard.append(enableLabel);

  const detectorCard = doc.createElement("section");
  detectorCard.className = "dc-pref-card";
  const detectorHeader = doc.createElement("div");
  detectorHeader.className = "dc-pref-section-head";
  const detectorTitle = doc.createElement("strong");
  detectorTitle.textContent = getString("prefs-detectors-title");
  const detectorDetail = doc.createElement("span");
  detectorDetail.className = "dc-pref-detail";
  detectorDetail.textContent = getString("prefs-detectors-detail");
  const detectorSummary = doc.createElement("span");
  detectorSummary.className = "dc-pref-summary";
  detectorHeader.append(detectorTitle, detectorDetail, detectorSummary);

  const detectorList = doc.createElement("div");
  detectorList.className = "dc-pref-detector-list";
  const detectorInputs: HTMLInputElement[] = [];

  for (const detector of AUDIT_DETECTOR_PREFERENCES) {
    const item = doc.createElement("label");
    item.className = "dc-pref-detector-item";
    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(getPref(detector.prefKey));
    checkbox.addEventListener("change", () => {
      setPref(detector.prefKey, checkbox.checked);
      updateDetectorState();
    });

    const text = doc.createElement("span");
    text.textContent = getString(detector.titleL10nId);

    item.append(checkbox, text);
    detectorList.append(item);
    detectorInputs.push(checkbox);
  }

  const updateDetectorState = () => {
    const enabled = enableInput.checked;
    detectorList.classList.toggle("is-disabled", !enabled);
    for (const detectorInput of detectorInputs) {
      detectorInput.disabled = !enabled;
    }
    detectorSummary.textContent = getString("prefs-detectors-selected-count", {
      args: {
        selected: detectorInputs.filter((input) => input.checked).length,
        total: detectorInputs.length,
      },
    });
  };

  enableInput.addEventListener("change", () => {
    setPref("enable", enableInput.checked);
    updateDetectorState();
  });

  detectorCard.append(detectorHeader, detectorList);
  root.append(enableCard, detectorCard);
  updateDetectorState();
}
