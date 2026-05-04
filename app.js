const RECEPTION_CUES = [
  "Grand Entrance",
  "First Dance",
  "Father/Daughter",
  "Mother/Son",
  "Cake Cutting",
  "Last Dance",
];
const CEREMONY_CUES = [
  "Prelude",
  "Family Seating",
  "Wedding Party Processional",
  "Partner Processional",
  "Main Entrance",
  "Ceremony Interlude",
  "Unity Ceremony",
  "Recessional",
  "Postlude",
];
const CUES = [...RECEPTION_CUES, ...CEREMONY_CUES];
const CUE_PAGES = [
  ...RECEPTION_CUES.map(() => "reception"),
  ...CEREMONY_CUES.map(() => "ceremony"),
];

const DB_NAME = "wedding-cue-db";
const STORE_NAME = "cue-files";
const SETTINGS_KEY = "weddingCueSettings";
const EVENT_META_KEY = "weddingCueMeta";
const ACTIVE_PAGE_KEY = "vowCueActivePage";
const SHOW_MODE_KEY = "vowCueShowMode";
const EVENT_FILE_VERSION = 1;
const HOLD_TO_PLAY_MS = 850;
const FADE_SCHEDULE_GUARD_SECONDS = 0.02;
const DEFAULT_FADE_DURATION = 5;
const OUTPUT_METER_REFERENCE_DB = -12;
const OUTPUT_METER_REFERENCE_LEVEL = 10 ** (OUTPUT_METER_REFERENCE_DB / 20);
const OUTPUT_METER_SILENT_LEVEL = 0.006;
const BASE64_DECODE_CHUNK_SIZE = 262144;
const importUtils = window.VowCueImportUtils || {};
const logicUtils = window.VowCueLogic || {};
const buildImportedFileName =
  importUtils.buildImportedFileName ||
  (({ cueName = "", eventName = "", contentType = "application/octet-stream" } = {}) => {
    const extension = String(contentType || "application/octet-stream").startsWith("audio/") ? "audio" : "bin";
    return [eventName, cueName].filter(Boolean).join("-") || `imported-file.${extension}`;
  });
const isLikelyDirectAudioUrl = importUtils.isLikelyDirectAudioUrl || (() => false);

const defaultSettings = () =>
  CUES.map((name) => ({
    name,
    fadeInEnabled: false,
    fadeInAt: "",
    fadeEnabled: false,
    fadeAt: "",
    sourceUrl: "",
    importStatus: "",
    importProgress: "0%",
    fileName: "",
    duration: null,
  }));

const state = {
  audioContext: null,
  source: null,
  gain: null,
  analyser: null,
  meterData: null,
  playbackStatus: "idle",
  storageStatus: "saved",
  lastError: "",
  startedAt: 0,
  startOffset: 0,
  pausedAt: 0,
  duration: 0,
  waveformPeaks: [],
  importingCueIndexes: new Set(),
  linkPanelCueIndexes: new Set(),
  currentCueIndex: null,
  fading: false,
  fadeEndsAtElapsed: null,
  animationFrame: null,
  plannedFadeTimer: null,
  fadeStopTimer: null,
  setupCueIndexes: new Set(),
  ...loadEventMeta(),
  activePage: loadActivePage(),
  showMode: loadShowMode(),
  settings: loadSettings(),
  files: new Map(),
};

const els = {
  cueGrid: document.querySelector("#cueGrid"),
  ceremonyCueGrid: document.querySelector("#ceremonyCueGrid"),
  cueTemplate: document.querySelector("#cueTemplate"),
  showState: document.querySelector("#showState"),
  saveState: document.querySelector("#saveState"),
  showModeButton: document.querySelector("#showModeButton"),
  playbackStateLabel: document.querySelector("#playbackStateLabel"),
  pageReadyLabel: document.querySelector("#pageReadyLabel"),
  attentionLabel: document.querySelector("#attentionLabel"),
  preflightMessage: document.querySelector("#preflightMessage"),
  preflightPanel: document.querySelector("#preflightPanel"),
  eventNameInput: document.querySelector("#eventNameInput"),
  nowTitle: document.querySelector("#nowTitle"),
  nowMeta: document.querySelector("#nowMeta"),
  remainingLabel: document.querySelector("#remainingLabel"),
  remainingTime: document.querySelector("#remainingTime"),
  elapsedTime: document.querySelector("#elapsedTime"),
  durationTime: document.querySelector("#durationTime"),
  waveformCanvas: document.querySelector("#waveformCanvas"),
  outputMeterFill: document.querySelector("#outputMeterFill"),
  outputMeterLabel: document.querySelector("#outputMeterLabel"),
  newEventButton: document.querySelector("#newEventButton"),
  openEventButton: document.querySelector("#openEventButton"),
  saveEventButton: document.querySelector("#saveEventButton"),
  openEventInput: document.querySelector("#openEventInput"),
  eventPanelButton: document.querySelector("#eventPanelButton"),
  eventPanel: document.querySelector("#eventPanel"),
  fadeDurationDownButton: document.querySelector("#fadeDurationDownButton"),
  fadeDurationUpButton: document.querySelector("#fadeDurationUpButton"),
  fadeDurationValue: document.querySelector("#fadeDurationValue"),
  pageTabs: document.querySelectorAll("[data-page-tab]"),
  pagePanels: document.querySelectorAll("[data-page-panel]"),
};

init();

async function init() {
  els.eventNameInput.value = state.eventName;
  updateFadeDurationDisplay();
  updateShowMode();
  updateStorageStatus();
  renderCues();
  await loadStoredFiles();
  hydrateFileLabels();
  wireTransport();
  wirePageTabs();
  switchPage(state.activePage, { persist: false });
  window.addEventListener("resize", () => drawWaveform(getPlaybackProgress()));
  drawWaveform(0);
  updateGlobalReadiness();
}

function loadEventMeta() {
  try {
    const meta = {
      eventName: "",
      fadeDuration: DEFAULT_FADE_DURATION,
      ...JSON.parse(localStorage.getItem(EVENT_META_KEY)),
    };
    return {
      eventName: typeof meta.eventName === "string" ? meta.eventName : "",
      fadeDuration: clamp(Number(meta.fadeDuration || DEFAULT_FADE_DURATION), 1, 60),
    };
  } catch {
    return { eventName: "", fadeDuration: DEFAULT_FADE_DURATION };
  }
}

function saveEventMeta() {
  try {
    localStorage.setItem(
      EVENT_META_KEY,
      JSON.stringify({
        eventName: state.eventName,
        fadeDuration: state.fadeDuration,
      }),
    );
    setStorageStatus("saved");
  } catch {
    setStorageStatus("error", "Local save failed");
  }
}

function loadActivePage() {
  const page = localStorage.getItem(ACTIVE_PAGE_KEY);
  return page === "ceremony" ? "ceremony" : "reception";
}

function saveActivePage() {
  try {
    localStorage.setItem(ACTIVE_PAGE_KEY, state.activePage);
  } catch {
    setStorageStatus("error", "Local save failed");
  }
}

function loadShowMode() {
  return localStorage.getItem(SHOW_MODE_KEY) === "true";
}

function saveShowMode() {
  try {
    localStorage.setItem(SHOW_MODE_KEY, String(state.showMode));
  } catch {
    setStorageStatus("error", "Local save failed");
  }
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!Array.isArray(stored)) return defaultSettings();
    return CUES.map((name, index) => ({ ...defaultSettings()[index], ...stored[index], name }));
  } catch {
    return defaultSettings();
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    setStorageStatus("saved");
  } catch {
    setStorageStatus("error", "Local save failed");
  }
}

function renderCues() {
  CUES.forEach((cueName, index) => {
    const fragment = els.cueTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".cue-card");
    const fileInput = fragment.querySelector(".file-input");
    const linkImportButton = fragment.querySelector(".link-import-button");
    const sourceUrl = fragment.querySelector(".source-url");
    const stubImportButton = fragment.querySelector(".stub-import-button");
    const removeFileButton = fragment.querySelector(".remove-file-button");
    const setupButton = fragment.querySelector(".cue-setup-button");
    const fadeInEnabled = fragment.querySelector(".fade-in-enabled");
    const fadeInAt = fragment.querySelector(".fade-in-at");
    const fadeEnabled = fragment.querySelector(".fade-enabled");
    const fadeAt = fragment.querySelector(".fade-at");
    const playButton = fragment.querySelector(".play-button");
    const fadeCueButton = fragment.querySelector(".fade-cue-button");
    const stopCueButton = fragment.querySelector(".stop-cue-button");

    card.dataset.cueIndex = index;
    fragment.querySelector(".cue-number").textContent = `Cue ${getCuePagePosition(index) + 1}`;
    fragment.querySelector(".cue-title").textContent = cueName;
    fadeInEnabled.checked = state.settings[index].fadeInEnabled;
    fadeInAt.value = state.settings[index].fadeInAt;
    fadeEnabled.checked = state.settings[index].fadeEnabled;
    fadeAt.value = state.settings[index].fadeAt;
    sourceUrl.value = state.settings[index].sourceUrl;

    fileInput.addEventListener("change", (event) => handleFileChange(index, event));
    setupButton.addEventListener("click", () => toggleCueSetup(index));
    linkImportButton.addEventListener("click", () => openCueLinkPanel(index));
    sourceUrl.addEventListener("input", () => {
      state.settings[index].sourceUrl = sourceUrl.value.trim();
      state.settings[index].importStatus = sourceUrl.value.trim() ? "Link saved" : "";
      saveSettings();
      updateCueCard(index);
    });
    stubImportButton.addEventListener("click", () => runStubImport(index));
    fadeInEnabled.addEventListener("change", () => {
      state.settings[index].fadeInEnabled = fadeInEnabled.checked;
      saveSettings();
      updateCueCard(index);
    });
    fadeInAt.addEventListener("input", () => {
      state.settings[index].fadeInAt = fadeInAt.value.trim();
      saveSettings();
      updateCueCard(index);
    });
    fadeEnabled.addEventListener("change", () => {
      state.settings[index].fadeEnabled = fadeEnabled.checked;
      saveSettings();
      updateCueCard(index);
    });
    fadeAt.addEventListener("input", () => {
      state.settings[index].fadeAt = fadeAt.value.trim();
      saveSettings();
      updateCueCard(index);
    });
    wireHoldAction(removeFileButton, {
      idleText: "Hold To Remove",
      armedText: "Release Cancels",
      action: () => removeCueFile(index),
    });
    fadeCueButton.addEventListener("click", () => fadeCurrent());
    wireHoldAction(playButton, {
      idleText: "Hold To Play",
      armedText: "Release Cancels",
      action: () => playCue(index),
    });
    wireHoldAction(stopCueButton, {
      idleText: "Hold To Stop",
      armedText: "Release Cancels",
      action: () => stopPlayback(),
    });

    getCueGridForIndex(index).appendChild(fragment);
    updateCueCard(index);
  });
}

async function handleFileChange(index, event) {
  if (state.showMode) {
    event.target.value = "";
    return;
  }

  const file = event.target.files?.[0];
  if (!file) return;

  try {
    await installImportedFile(index, file);
  } catch {
    window.alert("This audio file could not be decoded. Choose a different file for this cue.");
    event.target.value = "";
  }
}

async function removeCueFile(index) {
  if (state.showMode) return;

  const setting = state.settings[index];
  const hasCueFile = state.files.has(index) || Boolean(setting.fileName);
  if (!hasCueFile) return;

  if (state.currentCueIndex === index) {
    stopPlayback();
  }

  state.files.delete(index);
  state.settings[index] = {
    ...state.settings[index],
    fileName: "",
    duration: null,
  };
  saveSettings();
  try {
    await deleteStoredFile(index);
  } catch {
    window.alert("Could not remove stored file. Reload VowCue and try again.");
  }

  const card = getCueCard(index);
  if (card) {
    card.querySelector(".file-input").value = "";
    const button = card.querySelector(".remove-file-button");
    button.classList.remove("is-holding");
  }

  updateCueCard(index);
  updateGlobalReadiness();
}

function hydrateFileLabels() {
  CUES.forEach((_, index) => updateCueCard(index));
}

function toggleCueSetup(index) {
  if (state.showMode) return;

  if (state.setupCueIndexes.has(index)) {
    state.setupCueIndexes.delete(index);
  } else {
    state.setupCueIndexes.add(index);
  }
  updateCueCard(index);
}

function updateCueCard(index) {
  const card = getCueCard(index);
  if (!card) return;

  const setting = state.settings[index];
  const validation = getCueValidation(index);
  const hasFile = validation.hasFile;
  const isPlaying = state.currentCueIndex === index;
  const status = card.querySelector(".status-pill");
  const fileName = card.querySelector(".file-name");
  const cueMeta = card.querySelector(".cue-meta");
  const playButton = card.querySelector(".play-button");
  const fadeCueButton = card.querySelector(".fade-cue-button");
  const stopCueButton = card.querySelector(".stop-cue-button");
  const fileInput = card.querySelector(".file-input");
  const linkImportButton = card.querySelector(".link-import-button");
  const removeFileButton = card.querySelector(".remove-file-button");
  const setupButton = card.querySelector(".cue-setup-button");
  const setupPanel = card.querySelector(".cue-setup-panel");
  const linkImportPanel = card.querySelector(".link-import-panel");
  const sourceUrl = card.querySelector(".source-url");
  const stubImportButton = card.querySelector(".stub-import-button");
  const importStatus = card.querySelector(".import-status");
  const progressFill = card.querySelector(".import-progress-fill");
  const importing = state.importingCueIndexes.has(index);
  const setupOpen = state.setupCueIndexes.has(index);
  const setupLocked = state.showMode || state.playbackStatus === "loading";

  card.classList.toggle("is-playing", isPlaying);
  card.classList.toggle("is-importing", importing);
  card.classList.toggle("has-error", validation.severity === "error");
  card.setAttribute("aria-busy", importing ? "true" : "false");
  status.className = "status-pill";

  if (isPlaying) {
    status.textContent = state.playbackStatus === "fading" ? "Fading" : "Playing";
    status.classList.add("status-playing");
  } else if (validation.ready) {
    status.textContent = "Ready";
    status.classList.add("status-ready");
  } else if (validation.severity === "error") {
    status.textContent = "Error";
    status.classList.add("status-error");
  } else if (hasFile || setting.fileName) {
    status.textContent = "Check";
    status.classList.add("status-missing");
  } else {
    status.textContent = "Missing";
    status.classList.add("status-missing");
  }

  fileName.textContent = hasFile
    ? `${setting.fileName}${setting.duration ? ` - ${formatTime(setting.duration)}` : ""}`
    : "No file selected";
  cueMeta.textContent = validation.ready ? getCueMetaLabel(setting) : validation.issues[0] || getCueMetaLabel(setting);
  setupPanel.hidden = !setupOpen;
  setupButton.textContent = setupOpen ? "Hide Setup" : "Setup";
  setupButton.classList.toggle("is-active", setupOpen);
  linkImportPanel.hidden = !setting.sourceUrl && !state.linkPanelCueIndexes.has(index);
  sourceUrl.value = setting.sourceUrl || "";
  importStatus.textContent = setting.importStatus || (setting.sourceUrl ? "Link saved" : "No link set");
  progressFill.style.setProperty("--import-progress", setting.importProgress || "0%");
  fileInput.disabled = importing || setupLocked;
  linkImportButton.disabled = importing || setupLocked;
  sourceUrl.disabled = importing || setupLocked;
  stubImportButton.disabled = importing || setupLocked;
  stubImportButton.textContent = importing ? "Importing..." : "Import Audio";
  setupButton.disabled = setupLocked;
  playButton.hidden = isPlaying;
  playButton.disabled = importing || state.playbackStatus === "loading" || !validation.ready;
  fadeCueButton.hidden = !isPlaying;
  stopCueButton.hidden = !isPlaying;
  fadeCueButton.disabled = !isPlaying || state.fading;
  stopCueButton.disabled = !isPlaying;
  setHoldButtonLabel(playButton, "Hold To Play");
  setHoldButtonLabel(stopCueButton, "Hold To Stop");
  removeFileButton.disabled = importing || setupLocked || !hasFile;
  setHoldButtonLabel(removeFileButton, hasFile ? "Hold To Remove" : "No File");
}

function openCueLinkPanel(index) {
  if (state.showMode) return;

  state.setupCueIndexes.add(index);
  state.linkPanelCueIndexes.add(index);
  const setting = state.settings[index];
  if (!setting.sourceUrl) {
    setting.importStatus = "Paste a link to import audio";
    setting.importProgress = "0%";
    saveSettings();
  }
  updateCueCard(index);

  const input = getCueCard(index)?.querySelector(".source-url");
  input?.focus();
  input?.select();
}

function getCueMetaLabel(setting) {
  const parts = [];
  if (setting.fadeInEnabled && parseTime(setting.fadeInAt || "0") !== null) {
    parts.push(`In ${normalizeTimeLabel(setting.fadeInAt || "0")}`);
  }
  if (setting.fadeEnabled && parseTime(setting.fadeAt) !== null) {
    parts.push(`Out ${normalizeTimeLabel(setting.fadeAt)}`);
  }
  return parts.length ? `${parts.join(" / ")} - ${getAppFadeDuration()}s fades` : "No planned fades";
}

function getCueValidation(index) {
  const setting = state.settings[index] || {};
  const hasFile = state.files.has(index);
  const validation = logicUtils.validateCueSetting
    ? logicUtils.validateCueSetting(setting, { hasFile, fadeDuration: getAppFadeDuration() })
    : { ready: hasFile, issues: hasFile ? [] : ["No file loaded"], severity: hasFile ? "ready" : "warning" };

  return {
    hasFile,
    ...validation,
  };
}

async function runStubImport(index) {
  const setting = state.settings[index];
  if (state.importingCueIndexes.has(index)) return;
  if (!setting.sourceUrl) {
    setting.importStatus = "Paste a link first";
    setting.importProgress = "0%";
    saveSettings();
    updateCueCard(index);
    return;
  }

  state.importingCueIndexes.add(index);
  setting.importStatus = "Starting import...";
  setting.importProgress = "8%";
  saveSettings();
  updateCueCard(index);
  updateGlobalReadiness();
  await nextFrame();

  try {
    const importedFile = isDesktopImporterAvailable()
      ? await importCueFileFromDesktop(index)
      : await importCueFileFromDirectLink(index);

    state.settings[index].importStatus = "Saving imported audio...";
    state.settings[index].importProgress = "82%";
    saveSettings();
    updateCueCard(index);

    await installImportedFile(index, importedFile);

    state.settings[index].importStatus = "Import complete";
    state.settings[index].importProgress = "100%";
    saveSettings();
    updateCueCard(index);
  } catch (error) {
    state.settings[index].importStatus = getImportFailureMessage(error);
    state.settings[index].importProgress = "0%";
    saveSettings();
    updateCueCard(index);
  } finally {
    state.importingCueIndexes.delete(index);
    updateCueCard(index);
    updateGlobalReadiness();
  }
}

function isDesktopImporterAvailable() {
  return typeof window.__TAURI__?.core?.invoke === "function";
}

async function installImportedFile(index, file) {
  await nextFrame();
  const duration = await validateCueAudioFile(file);
  state.files.set(index, file);
  state.settings[index].fileName = file.name;
  state.settings[index].duration = duration;
  saveSettings();
  await nextFrame();
  try {
    await putStoredFile(index, file);
  } catch {
    setStorageStatus("error", "Cue is loaded for this session, but local persistence failed.");
    window.alert("Cue loaded, but VowCue could not save it locally. Save a .wed backup before closing.");
  }
  updateCueCard(index);
  updateGlobalReadiness();
}

async function validateCueAudioFile(file) {
  const audioContext = await getAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  return audioBuffer.duration;
}

async function importCueFileFromDesktop(index) {
  const setting = state.settings[index];
  state.settings[index].importStatus = "Downloading with yt-dlp...";
  state.settings[index].importProgress = "24%";
  saveSettings();
  updateCueCard(index);
  await nextFrame();

  const payload = await window.__TAURI__.core.invoke("download_audio_import", {
    sourceUrl: setting.sourceUrl,
    cueName: setting.name,
    eventName: state.eventName,
  });

  state.settings[index].importStatus = "Finalizing audio file...";
  state.settings[index].importProgress = "68%";
  saveSettings();
  updateCueCard(index);
  await nextFrame();

  return await eventPayloadToFile(payload);
}

async function importCueFileFromDirectLink(index) {
  const setting = state.settings[index];
  if (!isValidHttpUrl(setting.sourceUrl)) {
    throw new Error("INVALID_SOURCE_URL");
  }

  state.settings[index].importStatus = "Downloading direct audio file...";
  state.settings[index].importProgress = "24%";
  saveSettings();
  updateCueCard(index);
  await nextFrame();

  const response = await fetch(setting.sourceUrl);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const blob = await response.blob();
  const contentType = blob.type || "application/octet-stream";
  if (!contentType.startsWith("audio/") && !isLikelyDirectAudioUrl(setting.sourceUrl)) {
    throw new Error("Web preview can only import direct audio links. Use the desktop build for yt-dlp imports.");
  }

  state.settings[index].importStatus = "Preparing imported file...";
  state.settings[index].importProgress = "68%";
  saveSettings();
  updateCueCard(index);
  await nextFrame();

  return new File(
    [blob],
    buildImportedFileName({
      cueName: setting.name,
      eventName: state.eventName,
      sourceUrl: setting.sourceUrl,
      contentType,
    }),
    {
      type: contentType,
      lastModified: Date.now(),
    },
  );
}

function getImportFailureMessage(error) {
  const message = String(error?.message || error || "Import failed.");
  if (message.includes("YT_DLP_MISSING")) {
    return "yt-dlp is not installed on this computer yet.";
  }
  if (message.includes("DIRECT_AUDIO_ONLY")) {
    return "Web preview can only import direct audio links.";
  }
  if (message.includes("INVALID_SOURCE_URL")) {
    return "Paste a valid http or https link first.";
  }
  if (message.includes("Failed to fetch") || message.includes("Download failed")) {
    return "Could not download that link. Use a direct audio URL in web preview, or use the desktop build.";
  }
  return message;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function wireHoldAction(button, options) {
  let timer = null;
  let frame = null;
  let startedAt = 0;
  let armed = false;

  const reset = () => {
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = null;
    frame = null;
    armed = false;
    button.classList.remove("is-holding");
    button.style.setProperty("--hold-progress", "0%");
    setHoldButtonLabel(button, options.idleText);
  };

  const updateProgress = () => {
    const elapsed = performance.now() - startedAt;
    const progress = clamp(elapsed / HOLD_TO_PLAY_MS, 0, 1);
    button.style.setProperty("--hold-progress", `${progress * 100}%`);
    if (progress < 1 && armed) {
      frame = requestAnimationFrame(updateProgress);
    }
  };

  const start = (event) => {
    if (button.disabled || armed) return;
    event.preventDefault();
    armed = true;
    startedAt = performance.now();
    button.classList.add("is-holding");
    setHoldButtonLabel(button, options.armedText);
    updateProgress();
    timer = window.setTimeout(() => {
      reset();
      options.action();
    }, HOLD_TO_PLAY_MS);
  };

  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", reset);
  button.addEventListener("pointerleave", reset);
  button.addEventListener("pointercancel", reset);
  button.addEventListener("click", (event) => event.preventDefault());
  button.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") start(event);
  });
  button.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") reset();
  });
}

function setHoldButtonLabel(button, text) {
  const label = button.querySelector("span");
  if (label) label.textContent = text;
}

function updateGlobalReadiness() {
  const pageIndexes = getPageCueIndexes(state.activePage);
  const validations = pageIndexes.map((index) => getCueValidation(index));
  const ready = validations.filter((validation) => validation.ready).length;
  const importing = state.importingCueIndexes.size > 0;
  const pageLabel = state.activePage === "ceremony" ? "Ceremony" : "Reception";
  els.showState.textContent =
    ready === pageIndexes.length ? `${pageLabel} Ready` : `${ready}/${pageIndexes.length} ${pageLabel} Ready`;
  els.newEventButton.disabled = importing || state.showMode;
  els.openEventButton.disabled = importing || state.showMode;
  els.saveEventButton.disabled = importing;
  els.fadeDurationDownButton.disabled = importing || state.showMode || getAppFadeDuration() <= 1;
  els.fadeDurationUpButton.disabled = importing || state.showMode || getAppFadeDuration() >= 60;
  els.eventNameInput.disabled = state.showMode;
  els.eventPanelButton.disabled = importing || state.showMode;
  updatePreflight();
}

function wireTransport() {
  els.eventNameInput.addEventListener("input", () => {
    state.eventName = els.eventNameInput.value.trim();
    saveEventMeta();
  });
  els.showModeButton.addEventListener("click", () => toggleShowMode());
  els.eventPanelButton.addEventListener("click", () => toggleTopPanel("event"));
  els.fadeDurationDownButton.addEventListener("click", () => adjustFadeDuration(-1));
  els.fadeDurationUpButton.addEventListener("click", () => adjustFadeDuration(1));
  els.newEventButton.addEventListener("click", () => newEvent());
  els.saveEventButton.addEventListener("click", () => saveEventFile());
  els.openEventButton.addEventListener("click", () => els.openEventInput.click());
  els.openEventInput.addEventListener("change", (event) => openEventFile(event));
}

function toggleShowMode() {
  state.showMode = !state.showMode;
  saveShowMode();
  updateShowMode();
  updateGlobalReadiness();
  hydrateFileLabels();
}

function updateShowMode() {
  document.querySelector(".app-shell").classList.toggle("is-show-mode", state.showMode);
  els.showModeButton.setAttribute("aria-pressed", String(state.showMode));
  els.showModeButton.textContent = state.showMode ? "Show Mode On" : "Show Mode";
  if (state.showMode) {
    state.setupCueIndexes.clear();
    state.linkPanelCueIndexes.clear();
    els.eventPanel.hidden = true;
    els.eventPanelButton.classList.remove("is-active");
  }
}

function setPlaybackStatus(status, message = "") {
  state.playbackStatus = status;
  if (message) state.lastError = message;
  updatePreflight();
}

function setStorageStatus(status, message = "") {
  state.storageStatus = status;
  if (message) state.lastError = message;
  updateStorageStatus();
}

function updateStorageStatus() {
  els.saveState.classList.toggle("is-dirty", state.storageStatus === "dirty");
  els.saveState.classList.toggle("is-error", state.storageStatus === "error");
  if (state.storageStatus === "error") {
    els.saveState.textContent = "Save error";
  } else if (state.storageStatus === "dirty") {
    els.saveState.textContent = "Saving";
  } else {
    els.saveState.textContent = "Local saved";
  }
}

function updatePreflight() {
  const pageIndexes = getPageCueIndexes(state.activePage);
  const validations = pageIndexes.map((index) => getCueValidation(index));
  const ready = validations.filter((validation) => validation.ready).length;
  const attention = validations.filter((validation) => !validation.ready).length;
  const importing = state.importingCueIndexes.size;
  const playbackLabel = {
    idle: "Idle",
    loading: "Loading",
    playing: "Playing",
    fading: "Fading",
    stopping: "Stopping",
    error: "Error",
  }[state.playbackStatus] || "Idle";

  els.playbackStateLabel.textContent = playbackLabel;
  els.pageReadyLabel.textContent = `${ready}/${pageIndexes.length}`;
  els.attentionLabel.textContent = String(attention + importing);
  els.preflightPanel.classList.toggle("is-ready", ready === pageIndexes.length && importing === 0);
  els.preflightPanel.classList.toggle("has-warning", attention > 0 || importing > 0);
  els.preflightPanel.classList.toggle("has-error", state.playbackStatus === "error" || state.storageStatus === "error");

  if (state.playbackStatus === "error" || state.storageStatus === "error") {
    els.preflightMessage.textContent = state.lastError || "Resolve the reported error before showtime.";
  } else if (importing > 0) {
    els.preflightMessage.textContent = "Import in progress. Leave VowCue open until it completes.";
  } else if (ready === pageIndexes.length) {
    els.preflightMessage.textContent = state.showMode ? "Show mode locked. Playback controls only." : "All cues on this page are ready.";
  } else {
    const firstIssueIndex = validations.findIndex((validation) => !validation.ready);
    const issue = validations[firstIssueIndex]?.issues[0] || "Load remaining cues.";
    els.preflightMessage.textContent = issue;
  }
}

function toggleTopPanel(panel) {
  const eventOpen = panel === "event" && els.eventPanel.hidden;
  els.eventPanel.hidden = !eventOpen;
  els.eventPanelButton.classList.toggle("is-active", eventOpen);
}

function adjustFadeDuration(delta) {
  state.fadeDuration = clamp(getAppFadeDuration() + delta, 1, 60);
  saveEventMeta();
  updateFadeDurationDisplay();
  hydrateFileLabels();
  updateGlobalReadiness();
  if (state.currentCueIndex !== null) updatePlayingDisplay();
}

function updateFadeDurationDisplay() {
  els.fadeDurationValue.textContent = `${getAppFadeDuration()}s`;
}

function wirePageTabs() {
  els.pageTabs.forEach((tab) => {
    tab.addEventListener("click", () => switchPage(tab.dataset.pageTab));
  });
}

function switchPage(page, options = {}) {
  const nextPage = page === "ceremony" ? "ceremony" : "reception";
  state.activePage = nextPage;

  els.pageTabs.forEach((tab) => {
    const isActive = tab.dataset.pageTab === nextPage;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  els.pagePanels.forEach((panel) => {
    const isActive = panel.dataset.pagePanel === nextPage;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
  });

  if (options.persist !== false) {
    saveActivePage();
  }

  drawWaveform(getPlaybackProgress());
  updateGlobalReadiness();
}

async function newEvent() {
  if (state.showMode) return;

  const okay = window.confirm("Clear this event and remove all loaded cue files?");
  if (!okay) return;

  stopPlayback();
  await clearStoredFiles();
  state.files.clear();
  state.linkPanelCueIndexes.clear();
  state.setupCueIndexes.clear();
  state.eventName = "";
  state.fadeDuration = DEFAULT_FADE_DURATION;
  state.settings = defaultSettings();
  els.eventNameInput.value = "";
  updateFadeDurationDisplay();
  saveEventMeta();
  saveSettings();
  syncCueControls();
  hydrateFileLabels();
  CUES.forEach((_, index) => {
    const card = getCueCard(index);
    if (card) card.querySelector(".file-input").value = "";
  });
  updateGlobalReadiness();
}

async function playCue(index) {
  const file = state.files.get(index);
  if (!file) return;

  const validation = getCueValidation(index);
  if (!validation.ready) {
    window.alert(`This cue is not ready: ${validation.issues[0] || "check cue setup"}.`);
    return;
  }

  if (state.source) {
    const okay = window.confirm("Stop the current cue and start this one from the top?");
    if (!okay) return;
    stopPlayback({ resetDisplay: false });
  }

  setPlaybackStatus("loading");
  CUES.forEach((_, cueIndex) => updateCueCard(cueIndex));
  const audioContext = await getAudioContext();
  let audioBuffer;
  try {
    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    setPlaybackStatus("error", "Audio decode failed. Choose a different file for this cue.");
    window.alert("This audio file could not be decoded. Choose a different file for this cue.");
    updateCueCard(index);
    return;
  }
  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.78;

  source.buffer = audioBuffer;
  const fadeIn = getFadeInWindow(state.settings[index], audioBuffer.duration);
  const startOffset = fadeIn ? fadeIn.at : 0;
  if (fadeIn) {
    scheduleFadeInGain(gain.gain, audioContext.currentTime, fadeIn.duration);
  } else {
    gain.gain.setValueAtTime(1, audioContext.currentTime);
  }
  source.connect(gain).connect(analyser).connect(audioContext.destination);

  state.source = source;
  state.gain = gain;
  state.analyser = analyser;
  state.meterData = new Uint8Array(analyser.fftSize);
  state.startedAt = audioContext.currentTime - startOffset;
  state.startOffset = startOffset;
  state.duration = audioBuffer.duration;
  state.waveformPeaks = getWaveformPeaks(audioBuffer, getWaveformPeakCount());
  state.settings[index].duration = audioBuffer.duration;
  saveSettings();
  state.currentCueIndex = index;
  state.fading = false;
  state.fadeEndsAtElapsed = null;
  setPlaybackStatus("playing");

  source.onended = () => {
    if (state.currentCueIndex === index) {
      stopPlayback();
    }
  };

  source.start(0, startOffset);
  schedulePlannedFade(index);
  updatePlayingDisplay();
  CUES.forEach((_, cueIndex) => updateCueCard(cueIndex));
  drawWaveform(getPlaybackProgress(startOffset));
  tick();
}

async function getAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }
  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
  return state.audioContext;
}

function schedulePlannedFade(index) {
  clearTimeout(state.plannedFadeTimer);
  const setting = state.settings[index];
  if (!setting.fadeEnabled) return;

  const fadeAt = parseTime(setting.fadeAt);
  if (fadeAt === null) return;

  const delayMs = Math.max(0, (fadeAt - getElapsedPlaybackTime()) * 1000);
  state.plannedFadeTimer = window.setTimeout(() => fadeCurrent(), delayMs);
}

function fadeCurrent() {
  if (!state.source || !state.gain || state.fading) return;

  const cueIndex = state.currentCueIndex;
  const cue = state.settings[state.currentCueIndex];
  const duration = getAppFadeDuration();
  const now = state.audioContext.currentTime;
  const currentVolume = getCurrentCueGain(cue, getElapsedPlaybackTime());

  state.fading = true;
  setPlaybackStatus("fading");
  state.fadeEndsAtElapsed = getElapsedPlaybackTime() + duration;
  state.gain.gain.cancelScheduledValues(now);
  state.gain.gain.setValueAtTime(currentVolume, now);
  state.gain.gain.linearRampToValueAtTime(0, now + duration);
  clearTimeout(state.fadeStopTimer);
  state.fadeStopTimer = window.setTimeout(() => {
    if (state.currentCueIndex === cueIndex && state.fading) {
      stopPlayback();
    }
  }, duration * 1000 + 80);
  updatePlayingDisplay("Fading");
  updateCueCard(state.currentCueIndex);
}

function stopPlayback(options = {}) {
  if (state.source) setPlaybackStatus("stopping");
  clearTimeout(state.plannedFadeTimer);
  clearTimeout(state.fadeStopTimer);
  cancelAnimationFrame(state.animationFrame);

  if (state.source) {
    try {
      state.source.onended = null;
      state.source.stop(0);
    } catch {
      // Source may already have ended.
    }
    state.source.disconnect();
  }
  if (state.gain) {
    state.gain.disconnect();
  }
  if (state.analyser) {
    state.analyser.disconnect();
  }

  const priorCueIndex = state.currentCueIndex;
  state.source = null;
  state.gain = null;
  state.analyser = null;
  state.meterData = null;
  state.currentCueIndex = null;
  state.startOffset = 0;
  state.duration = 0;
  state.waveformPeaks = [];
  state.fading = false;
  state.fadeEndsAtElapsed = null;
  state.fadeStopTimer = null;
  setPlaybackStatus("idle");

  if (options.resetDisplay !== false) {
    els.nowTitle.textContent = "Nothing playing";
    els.nowMeta.textContent = "Ready.";
    els.remainingLabel.textContent = "Time Remaining";
    els.remainingTime.textContent = "00:00";
    els.elapsedTime.textContent = "00:00";
    els.durationTime.textContent = "00:00";
    drawWaveform(0);
    updateOutputMeter(0);
  }

  if (priorCueIndex !== null) updateCueCard(priorCueIndex);
  updateGlobalReadiness();
}

function updatePlayingDisplay(prefix = "Playing") {
  const cue = state.settings[state.currentCueIndex];
  const fadeInLabel =
    cue.fadeInEnabled && parseTime(cue.fadeInAt || "0") !== null
      ? `Starts at ${normalizeTimeLabel(cue.fadeInAt || "0")} and fades in over ${getAppFadeDuration()}s`
      : "No fade in";
  const fadeLabel =
    cue.fadeEnabled && parseTime(cue.fadeAt) !== null
      ? `Planned fade at ${normalizeTimeLabel(cue.fadeAt)} over ${getAppFadeDuration()}s`
      : "No planned fade";

  els.nowTitle.textContent = cue.name;
  els.nowMeta.textContent = `${prefix}: ${cue.fileName}. ${fadeInLabel}. ${fadeLabel}.`;
}

function tick() {
  if (!state.source || !state.audioContext) return;

  const elapsed = Math.min(state.audioContext.currentTime - state.startedAt, state.duration);
  const remainingTarget = getRemainingTarget();
  const remaining = Math.max(0, remainingTarget - elapsed);
  els.remainingLabel.textContent =
    remainingTarget < state.duration ? "Time Until Fade Ends" : "Time Remaining";
  els.remainingTime.textContent = formatTime(remaining);
  els.elapsedTime.textContent = formatTime(elapsed);
  els.durationTime.textContent = formatTime(state.duration);
  drawWaveform(getPlaybackProgress(elapsed));
  updateOutputMeter();
  state.animationFrame = requestAnimationFrame(tick);
}

function getPlaybackProgress(elapsed) {
  if (!state.duration) return 0;
  const played = elapsed ?? (state.audioContext ? state.audioContext.currentTime - state.startedAt : 0);
  return clamp(played / state.duration, 0, 1);
}

function getRemainingTarget() {
  const cue = state.settings[state.currentCueIndex];
  if (logicUtils.getRemainingTarget) {
    return logicUtils.getRemainingTarget({
      duration: state.duration,
      fading: state.fading,
      fadeEndsAtElapsed: state.fadeEndsAtElapsed,
      fadeEnabled: Boolean(cue?.fadeEnabled),
      fadeAt: cue?.fadeAt,
      fadeDuration: getAppFadeDuration(),
    });
  }

  if (state.fading && state.fadeEndsAtElapsed !== null) return clamp(state.fadeEndsAtElapsed, 0, state.duration);
  if (!cue?.fadeEnabled) return state.duration;
  const fadeAt = parseTime(cue.fadeAt);
  return fadeAt === null ? state.duration : clamp(fadeAt + getAppFadeDuration(), 0, state.duration);
}

function getFadeInWindow(cue, duration) {
  if (!cue.fadeInEnabled) return 0;
  const fadeInAt = parseTime(cue.fadeInAt || "0");
  if (fadeInAt === null || fadeInAt >= duration) return null;
  const maxDuration = Math.max(1, duration - fadeInAt);
  return {
    at: fadeInAt,
    duration: clamp(getAppFadeDuration(), 1, maxDuration),
  };
}

function scheduleFadeInGain(gainParam, now, duration) {
  const fadeInStart = now + FADE_SCHEDULE_GUARD_SECONDS;
  const fadeInEnd = fadeInStart + duration;

  gainParam.cancelScheduledValues(now);
  gainParam.setValueAtTime(0, now);
  gainParam.setValueAtTime(0, fadeInStart);
  gainParam.linearRampToValueAtTime(1, fadeInEnd);
  gainParam.setValueAtTime(1, fadeInEnd + FADE_SCHEDULE_GUARD_SECONDS);
}

function getCurrentCueGain(cue, elapsed) {
  const fadeIn = getFadeInWindow(cue, state.duration);
  if (!fadeIn) return 1;
  if (elapsed <= fadeIn.at) return 0;
  if (elapsed >= fadeIn.at + fadeIn.duration) return 1;
  return clamp((elapsed - fadeIn.at) / fadeIn.duration, 0, 1);
}

function getElapsedPlaybackTime() {
  if (!state.audioContext || !state.source) return 0;
  return Math.min(state.audioContext.currentTime - state.startedAt, state.duration);
}

function getWaveformPeaks(audioBuffer, peakCount) {
  const channelCount = audioBuffer.numberOfChannels;
  const samplesPerPeak = Math.max(1, Math.floor(audioBuffer.length / peakCount));
  const peaks = [];

  for (let peakIndex = 0; peakIndex < peakCount; peakIndex += 1) {
    const start = peakIndex * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, audioBuffer.length);
    let max = 0;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      for (let sample = start; sample < end; sample += 1) {
        max = Math.max(max, Math.abs(data[sample]));
      }
    }

    peaks.push(max);
  }

  const strongest = Math.max(...peaks, 1);
  return peaks.map((peak) => peak / strongest);
}

function drawWaveform(progress) {
  const canvas = els.waveformCanvas;
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const panel = styles.getPropertyValue("--panel").trim() || "#0b0d0e";
  const muted = styles.getPropertyValue("--muted").trim() || "#596168";
  const accent = styles.getPropertyValue("--accent").trim() || "#36d6b2";
  const text = styles.getPropertyValue("--text").trim() || "#f4f1ea";
  context.fillStyle = panel;
  context.fillRect(0, 0, width, height);

  const peaks = state.waveformPeaks.length
    ? state.waveformPeaks
    : Array.from({ length: getWaveformPeakCount() }, (_, index) => {
        const phase = index / 11;
        return 0.14 + Math.abs(Math.sin(phase)) * 0.07;
      });
  const centerY = height / 2;
  const playedX = width * clamp(progress, 0, 1);

  drawWaveformShape(context, peaks, width, height, muted);
  context.save();
  context.beginPath();
  context.rect(0, 0, playedX, height);
  context.clip();
  drawWaveformShape(context, peaks, width, height, accent);
  context.restore();

  context.fillStyle = text;
  context.fillRect(Math.min(width - 2 * ratio, playedX), height * 0.12, 2 * ratio, height * 0.76);
  context.fillStyle = withAlpha(text, 0.16);
  context.fillRect(0, centerY - ratio / 2, width, ratio);
}

function updateOutputMeter(forcedLevel = null) {
  let level = forcedLevel;

  if (level === null) {
    level = getOutputLevel();
  }

  const rawLevel = clamp(level, 0, 1);
  const displayLevel = clamp(rawLevel / OUTPUT_METER_REFERENCE_LEVEL, 0, 1);
  els.outputMeterFill.style.setProperty("--meter-level", `${displayLevel * 100}%`);

  if (rawLevel < OUTPUT_METER_SILENT_LEVEL) {
    els.outputMeterLabel.textContent = "Silent";
    return;
  }

  els.outputMeterLabel.textContent = "Signal";
}

function getOutputLevel() {
  if (!state.analyser || !state.meterData) return 0;

  state.analyser.getByteTimeDomainData(state.meterData);
  let sumSquares = 0;
  for (let index = 0; index < state.meterData.length; index += 1) {
    const centered = (state.meterData[index] - 128) / 128;
    sumSquares += centered * centered;
  }

  return Math.sqrt(sumSquares / state.meterData.length);
}

function withAlpha(color, alpha) {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const parts = resolved.match(/\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
}

function getWaveformPeakCount() {
  const canvasWidth = els.waveformCanvas?.getBoundingClientRect().width || 900;
  return clamp(Math.floor(canvasWidth * 1.25), 420, 1600);
}

function drawWaveformShape(context, peaks, width, height, color) {
  const centerY = height / 2;
  const step = width / Math.max(1, peaks.length - 1);

  context.beginPath();
  peaks.forEach((peak, index) => {
    const x = index * step;
    const y = centerY - Math.max(2, peak * height * 0.43);
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      const priorX = (index - 0.5) * step;
      const priorPeak = peaks[index - 1];
      const priorY = centerY - Math.max(2, priorPeak * height * 0.43);
      context.quadraticCurveTo(priorX, priorY, x, y);
    }
  });

  for (let index = peaks.length - 1; index >= 0; index -= 1) {
    const x = index * step;
    const y = centerY + Math.max(2, peaks[index] * height * 0.43);
    if (index === peaks.length - 1) {
      context.lineTo(x, y);
    } else {
      const priorX = (index + 0.5) * step;
      const priorY = centerY + Math.max(2, peaks[index + 1] * height * 0.43);
      context.quadraticCurveTo(priorX, priorY, x, y);
    }
  }

  context.closePath();
  context.fillStyle = color;
  context.fill();
}

function parseTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);

  const parts = text.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => !/^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  if (numbers.some((number) => Number.isNaN(number))) return null;
  if (numbers.length === 2) {
    const [minutes, seconds] = numbers;
    if (seconds > 59) return null;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = numbers;
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function normalizeTimeLabel(value) {
  const seconds = parseTime(value);
  return seconds === null ? value : formatTime(seconds);
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getAppFadeDuration() {
  return clamp(Number(state.fadeDuration || DEFAULT_FADE_DURATION), 1, 60);
}

function getCueCard(index) {
  return document.querySelector(`[data-cue-index="${index}"]`);
}

function getCueGridForIndex(index) {
  return CUE_PAGES[index] === "ceremony" ? els.ceremonyCueGrid : els.cueGrid;
}

function getPageCueIndexes(page) {
  return CUE_PAGES.map((cuePage, index) => (cuePage === page ? index : -1)).filter((index) => index !== -1);
}

function getCuePagePosition(index) {
  return getPageCueIndexes(CUE_PAGES[index]).indexOf(index);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putStoredFile(index, file) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(file, String(index));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function deleteStoredFile(index) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(String(index));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function clearStoredFiles() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function loadStoredFiles() {
  let db;
  try {
    db = await openDb();
  } catch {
    setStorageStatus("error", "Local cue storage could not be opened.");
    hydrateFileLabels();
    updateGlobalReadiness();
    return;
  }
  await Promise.all(
    CUES.map(
      (_, index) =>
        new Promise((resolve) => {
          const transaction = db.transaction(STORE_NAME, "readonly");
          const request = transaction.objectStore(STORE_NAME).get(String(index));
          request.onsuccess = async () => {
            if (request.result) {
              state.files.set(index, request.result);
              if (!state.settings[index].fileName) {
                state.settings[index].fileName = request.result.name;
              }
              if (!state.settings[index].duration) {
                state.settings[index].duration = await readAudioDuration(request.result);
              }
              saveSettings();
              updateCueCard(index);
            }
            resolve();
          };
          request.onerror = () => resolve();
        }),
    ),
  );
}

function readAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    audio.src = url;
  });
}

async function saveEventFile() {
  setStorageStatus("dirty");
  try {
    const cues = await Promise.all(
      state.settings.map(async (setting, index) => {
        const file = state.files.get(index);
        const { fadeDuration, fadeInDuration, ...eventSetting } = setting;
        return {
          setting: { ...eventSetting },
          file: file ? await fileToEventPayload(file) : null,
        };
      }),
    );
    const event = {
      app: "VowCue",
      version: EVENT_FILE_VERSION,
      eventName: state.eventName,
      fadeDuration: getAppFadeDuration(),
      savedAt: new Date().toISOString(),
      cues,
    };
    const blob = new Blob([JSON.stringify(event)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${getEventFileSlug()}-${new Date().toISOString().slice(0, 10)}.wed`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStorageStatus("saved");
  } catch {
    setStorageStatus("error", "Could not create the .wed event file.");
    window.alert("VowCue could not create the .wed file. Check available disk/memory and try again.");
  }
}

async function openEventFile(event) {
  if (state.showMode) {
    event.target.value = "";
    return;
  }

  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    window.alert("That .wed file could not be read.");
    return;
  }

  if (!isValidEventFile(parsed)) {
    window.alert("That .wed file is not a valid VowCue event.");
    return;
  }

  stopPlayback();
  await clearStoredFiles();
  state.files.clear();
  state.linkPanelCueIndexes.clear();
  state.setupCueIndexes.clear();
  state.eventName = typeof parsed.eventName === "string" ? parsed.eventName : "";
  state.fadeDuration = clamp(Number(parsed.fadeDuration || DEFAULT_FADE_DURATION), 1, 60);
  els.eventNameInput.value = state.eventName;
  updateFadeDurationDisplay();
  saveEventMeta();
  state.settings = defaultSettings();
  let skippedFiles = 0;

  for (let index = 0; index < CUES.length; index += 1) {
    const cue = parsed.cues[index];
    const importedSetting = cue?.setting || {};
    state.settings[index] = {
      ...defaultSettings()[index],
      ...importedSetting,
      name: CUES[index],
    };

    if (cue?.file) {
      try {
        const importedFile = await eventPayloadToFile(cue.file);
        state.files.set(index, importedFile);
        state.settings[index].fileName = importedFile.name;
        state.settings[index].duration = await readAudioDuration(importedFile);
        try {
          await putStoredFile(index, importedFile);
        } catch {
          setStorageStatus("error", "Imported event loaded, but local cue persistence failed.");
        }
      } catch {
        skippedFiles += 1;
        state.settings[index].fileName = "";
        state.settings[index].duration = null;
      }
    }
  }

  saveSettings();
  syncCueControls();
  hydrateFileLabels();
  updateGlobalReadiness();
  if (skippedFiles > 0) {
    window.alert(`${skippedFiles} cue file(s) could not be imported and were skipped.`);
  }
}

function isValidEventFile(event) {
  return (
    event &&
    (event.app === "VowCue" || event.app === "Wedding Cue") &&
    event.version === EVENT_FILE_VERSION &&
    Array.isArray(event.cues) &&
    event.cues.length <= CUES.length
  );
}

function syncCueControls() {
  CUES.forEach((_, index) => {
    const card = getCueCard(index);
    const setting = state.settings[index];
    if (!card) return;
    card.querySelector(".fade-in-enabled").checked = setting.fadeInEnabled;
    card.querySelector(".fade-in-at").value = setting.fadeInAt || "";
    card.querySelector(".fade-enabled").checked = setting.fadeEnabled;
    card.querySelector(".fade-at").value = setting.fadeAt;
    card.querySelector(".source-url").value = setting.sourceUrl || "";
    updateCueCard(index);
  });
}

function getEventFileSlug() {
  const slug = state.eventName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "wedding-cue";
}

async function fileToEventPayload(file) {
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
    data: await fileToBase64(file),
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function eventPayloadToFile(payload) {
  if (
    !payload ||
    typeof payload.name !== "string" ||
    typeof payload.data !== "string" ||
    payload.data.length === 0
  ) {
    throw new Error("Invalid file payload");
  }
  const bytes = await base64ToBytes(payload.data);
  return new File([bytes], payload.name, {
    type: payload.type || "application/octet-stream",
    lastModified: payload.lastModified || Date.now(),
  });
}

async function base64ToBytes(base64) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Invalid base64 payload");
  }

  const byteLength = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  const bytes = new Uint8Array(byteLength);
  let byteOffset = 0;

  for (let index = 0; index < base64.length; index += BASE64_DECODE_CHUNK_SIZE) {
    const chunkEnd = Math.min(index + BASE64_DECODE_CHUNK_SIZE, base64.length);
    const chunk = base64.slice(index, chunkEnd);
    const binary = window.atob(chunk);
    for (let binaryIndex = 0; binaryIndex < binary.length; binaryIndex += 1) {
      bytes[byteOffset] = binary.charCodeAt(binaryIndex);
      byteOffset += 1;
    }
    await nextFrame();
  }

  return bytes;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
