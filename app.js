const CUES = [
  "Grand Entrance",
  "First Dance",
  "Father/Daughter",
  "Mother/Son",
  "Cake Cutting",
  "Last Dance",
];

const DB_NAME = "wedding-cue-db";
const STORE_NAME = "cue-files";
const SETTINGS_KEY = "weddingCueSettings";
const EVENT_META_KEY = "weddingCueMeta";
const EVENT_FILE_VERSION = 1;
const HOLD_TO_PLAY_MS = 850;

const defaultSettings = () =>
  CUES.map((name) => ({
    name,
    fadeInEnabled: false,
    fadeInDuration: 4,
    fadeEnabled: false,
    fadeAt: "",
    fadeDuration: 8,
    fileName: "",
    duration: null,
  }));

const state = {
  audioContext: null,
  source: null,
  gain: null,
  startedAt: 0,
  pausedAt: 0,
  duration: 0,
  waveformPeaks: [],
  currentCueIndex: null,
  fading: false,
  fadeEndsAtElapsed: null,
  animationFrame: null,
  plannedFadeTimer: null,
  ...loadEventMeta(),
  settings: loadSettings(),
  files: new Map(),
};

const els = {
  cueGrid: document.querySelector("#cueGrid"),
  cueTemplate: document.querySelector("#cueTemplate"),
  showState: document.querySelector("#showState"),
  eventNameInput: document.querySelector("#eventNameInput"),
  nowTitle: document.querySelector("#nowTitle"),
  nowMeta: document.querySelector("#nowMeta"),
  remainingLabel: document.querySelector("#remainingLabel"),
  remainingTime: document.querySelector("#remainingTime"),
  elapsedTime: document.querySelector("#elapsedTime"),
  durationTime: document.querySelector("#durationTime"),
  waveformCanvas: document.querySelector("#waveformCanvas"),
  newEventButton: document.querySelector("#newEventButton"),
  openEventButton: document.querySelector("#openEventButton"),
  saveEventButton: document.querySelector("#saveEventButton"),
  openEventInput: document.querySelector("#openEventInput"),
};

init();

async function init() {
  els.eventNameInput.value = state.eventName;
  renderCues();
  await loadStoredFiles();
  hydrateFileLabels();
  wireTransport();
  window.addEventListener("resize", () => drawWaveform(getPlaybackProgress()));
  drawWaveform(0);
  updateGlobalReadiness();
}

function loadEventMeta() {
  try {
    const meta = {
      eventName: "",
      ...JSON.parse(localStorage.getItem(EVENT_META_KEY)),
    };
    return { eventName: typeof meta.eventName === "string" ? meta.eventName : "" };
  } catch {
    return { eventName: "" };
  }
}

function saveEventMeta() {
  localStorage.setItem(
    EVENT_META_KEY,
    JSON.stringify({
      eventName: state.eventName,
    }),
  );
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function renderCues() {
  CUES.forEach((cueName, index) => {
    const fragment = els.cueTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".cue-card");
    const fileInput = fragment.querySelector(".file-input");
    const removeFileButton = fragment.querySelector(".remove-file-button");
    const fadeInEnabled = fragment.querySelector(".fade-in-enabled");
    const fadeInDuration = fragment.querySelector(".fade-in-duration");
    const fadeEnabled = fragment.querySelector(".fade-enabled");
    const fadeAt = fragment.querySelector(".fade-at");
    const fadeDuration = fragment.querySelector(".fade-duration");
    const playButton = fragment.querySelector(".play-button");
    const fadeCueButton = fragment.querySelector(".fade-cue-button");
    const stopCueButton = fragment.querySelector(".stop-cue-button");

    card.dataset.cueIndex = index;
    fragment.querySelector(".cue-number").textContent = `Cue ${index + 1}`;
    fragment.querySelector(".cue-title").textContent = cueName;
    fadeInEnabled.checked = state.settings[index].fadeInEnabled;
    fadeInDuration.value = state.settings[index].fadeInDuration;
    fadeEnabled.checked = state.settings[index].fadeEnabled;
    fadeAt.value = state.settings[index].fadeAt;
    fadeDuration.value = state.settings[index].fadeDuration;

    fileInput.addEventListener("change", (event) => handleFileChange(index, event));
    fadeInEnabled.addEventListener("change", () => {
      state.settings[index].fadeInEnabled = fadeInEnabled.checked;
      saveSettings();
      updateCueCard(index);
    });
    fadeInDuration.addEventListener("input", () => {
      state.settings[index].fadeInDuration = clamp(Number(fadeInDuration.value || 4), 1, 60);
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
    fadeDuration.addEventListener("input", () => {
      state.settings[index].fadeDuration = clamp(Number(fadeDuration.value || 8), 1, 60);
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

    els.cueGrid.appendChild(fragment);
    updateCueCard(index);
  });
}

async function handleFileChange(index, event) {
  const file = event.target.files?.[0];
  if (!file) return;

  state.files.set(index, file);
  state.settings[index].fileName = file.name;
  state.settings[index].duration = null;
  saveSettings();
  await putStoredFile(index, file);
  updateCueCard(index);
  updateGlobalReadiness();

  state.settings[index].duration = await readAudioDuration(file);
  saveSettings();
  updateCueCard(index);
}

async function removeCueFile(index) {
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

function updateCueCard(index) {
  const card = getCueCard(index);
  if (!card) return;

  const setting = state.settings[index];
  const hasFile = state.files.has(index) || Boolean(setting.fileName);
  const isPlaying = state.currentCueIndex === index;
  const status = card.querySelector(".status-pill");
  const fileName = card.querySelector(".file-name");
  const playButton = card.querySelector(".play-button");
  const fadeCueButton = card.querySelector(".fade-cue-button");
  const stopCueButton = card.querySelector(".stop-cue-button");
  const removeFileButton = card.querySelector(".remove-file-button");
  const fadeAt = parseTime(setting.fadeAt);
  const fadeInDuration = clamp(Number(setting.fadeInDuration || 4), 1, 60);
  const fadeDuration = clamp(Number(setting.fadeDuration || 8), 1, 60);
  const fadeValid =
    !setting.fadeEnabled ||
    (fadeAt !== null && (!setting.duration || fadeAt < setting.duration));
  const fadeInValid = !setting.fadeInEnabled || !setting.duration || fadeInDuration <= setting.duration;
  const cueValid = fadeValid && fadeInValid;

  card.classList.toggle("is-playing", isPlaying);
  status.className = "status-pill";

  if (isPlaying) {
    status.textContent = "Playing";
    status.classList.add("status-playing");
  } else if (hasFile && cueValid) {
    status.textContent = "Ready";
    status.classList.add("status-ready");
  } else if (hasFile) {
    status.textContent = "Check fade";
    status.classList.add("status-missing");
  } else {
    status.textContent = "Missing";
    status.classList.add("status-missing");
  }

  fileName.textContent = hasFile
    ? `${setting.fileName}${setting.duration ? ` - ${formatTime(setting.duration)}` : ""}`
    : "No file selected";
  playButton.hidden = isPlaying;
  playButton.disabled = !hasFile || !cueValid;
  fadeCueButton.hidden = !isPlaying;
  stopCueButton.hidden = !isPlaying;
  fadeCueButton.disabled = !isPlaying || state.fading;
  stopCueButton.disabled = !isPlaying;
  setHoldButtonLabel(playButton, "Hold To Play");
  setHoldButtonLabel(stopCueButton, "Hold To Stop");
  removeFileButton.disabled = !hasFile;
  setHoldButtonLabel(removeFileButton, hasFile ? "Hold To Remove" : "No File");
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
  const loaded = CUES.filter((_, index) => state.files.has(index)).length;
  els.showState.textContent = loaded === CUES.length ? "All Cues Ready" : `${loaded}/6 Cues Ready`;
}

function wireTransport() {
  els.eventNameInput.addEventListener("input", () => {
    state.eventName = els.eventNameInput.value.trim();
    saveEventMeta();
  });
  els.newEventButton.addEventListener("click", () => newEvent());
  els.saveEventButton.addEventListener("click", () => saveEventFile());
  els.openEventButton.addEventListener("click", () => els.openEventInput.click());
  els.openEventInput.addEventListener("change", (event) => openEventFile(event));
}

async function newEvent() {
  const okay = window.confirm("Clear this event and remove all loaded cue files?");
  if (!okay) return;

  stopPlayback();
  await clearStoredFiles();
  state.files.clear();
  state.eventName = "";
  state.settings = defaultSettings();
  els.eventNameInput.value = "";
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

  if (state.source) {
    const okay = window.confirm("Stop the current cue and start this one from the top?");
    if (!okay) return;
    stopPlayback({ resetDisplay: false });
  }

  const audioContext = await getAudioContext();
  let audioBuffer;
  try {
    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    window.alert("This audio file could not be decoded. Choose a different file for this cue.");
    return;
  }
  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();

  source.buffer = audioBuffer;
  const fadeInDuration = getFadeInDuration(state.settings[index], audioBuffer.duration);
  if (fadeInDuration > 0) {
    gain.gain.setValueAtTime(0, audioContext.currentTime);
    gain.gain.linearRampToValueAtTime(1, audioContext.currentTime + fadeInDuration);
  } else {
    gain.gain.setValueAtTime(1, audioContext.currentTime);
  }
  source.connect(gain).connect(audioContext.destination);

  state.source = source;
  state.gain = gain;
  state.startedAt = audioContext.currentTime;
  state.duration = audioBuffer.duration;
  state.waveformPeaks = getWaveformPeaks(audioBuffer, getWaveformPeakCount());
  state.settings[index].duration = audioBuffer.duration;
  saveSettings();
  state.currentCueIndex = index;
  state.fading = false;
  state.fadeEndsAtElapsed = null;

  source.onended = () => {
    if (state.currentCueIndex === index) {
      stopPlayback();
    }
  };

  source.start(0);
  schedulePlannedFade(index);
  updatePlayingDisplay();
  CUES.forEach((_, cueIndex) => updateCueCard(cueIndex));
  drawWaveform(0);
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

  const delayMs = Math.max(0, fadeAt * 1000);
  state.plannedFadeTimer = window.setTimeout(() => fadeCurrent(), delayMs);
}

function fadeCurrent() {
  if (!state.source || !state.gain || state.fading) return;

  const cue = state.settings[state.currentCueIndex];
  const duration = clamp(Number(cue.fadeDuration || 8), 1, 60);
  const now = state.audioContext.currentTime;
  const currentVolume = state.gain.gain.value;

  state.fading = true;
  state.fadeEndsAtElapsed = getElapsedPlaybackTime() + duration;
  state.gain.gain.cancelScheduledValues(now);
  state.gain.gain.setValueAtTime(currentVolume, now);
  state.gain.gain.linearRampToValueAtTime(0, now + duration);
  window.setTimeout(() => stopPlayback(), duration * 1000 + 80);
  updatePlayingDisplay("Fading");
  updateCueCard(state.currentCueIndex);
}

function stopPlayback(options = {}) {
  clearTimeout(state.plannedFadeTimer);
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

  const priorCueIndex = state.currentCueIndex;
  state.source = null;
  state.gain = null;
  state.currentCueIndex = null;
  state.duration = 0;
  state.waveformPeaks = [];
  state.fading = false;
  state.fadeEndsAtElapsed = null;

  if (options.resetDisplay !== false) {
    els.nowTitle.textContent = "Nothing playing";
    els.nowMeta.textContent = "Ready.";
    els.remainingLabel.textContent = "Time Remaining";
    els.remainingTime.textContent = "00:00";
    els.elapsedTime.textContent = "00:00";
    els.durationTime.textContent = "00:00";
    drawWaveform(0);
  }

  if (priorCueIndex !== null) updateCueCard(priorCueIndex);
  updateGlobalReadiness();
}

function updatePlayingDisplay(prefix = "Playing") {
  const cue = state.settings[state.currentCueIndex];
  const fadeInLabel = cue.fadeInEnabled ? `Fade in over ${cue.fadeInDuration}s` : "No fade in";
  const fadeLabel =
    cue.fadeEnabled && parseTime(cue.fadeAt) !== null
      ? `Planned fade at ${normalizeTimeLabel(cue.fadeAt)} over ${cue.fadeDuration}s`
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
  state.animationFrame = requestAnimationFrame(tick);
}

function getPlaybackProgress(elapsed) {
  if (!state.duration) return 0;
  const played = elapsed ?? (state.audioContext ? state.audioContext.currentTime - state.startedAt : 0);
  return clamp(played / state.duration, 0, 1);
}

function getRemainingTarget() {
  if (state.fading && state.fadeEndsAtElapsed !== null) {
    return clamp(state.fadeEndsAtElapsed, 0, state.duration);
  }

  const cue = state.settings[state.currentCueIndex];
  if (!cue?.fadeEnabled) return state.duration;

  const fadeAt = parseTime(cue.fadeAt);
  if (fadeAt === null) return state.duration;

  const fadeDuration = clamp(Number(cue.fadeDuration || 8), 1, 60);
  return clamp(fadeAt + fadeDuration, 0, state.duration);
}

function getFadeInDuration(cue, duration) {
  if (!cue.fadeInEnabled) return 0;
  return clamp(Number(cue.fadeInDuration || 4), 1, Math.max(1, duration));
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

function getCueCard(index) {
  return els.cueGrid.querySelector(`[data-cue-index="${index}"]`);
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
  const db = await openDb();
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
  const cues = await Promise.all(
    state.settings.map(async (setting, index) => {
      const file = state.files.get(index);
      return {
        setting: { ...setting },
        file: file ? await fileToEventPayload(file) : null,
      };
    }),
  );
  const event = {
    app: "VowCue",
    version: EVENT_FILE_VERSION,
    eventName: state.eventName,
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
}

async function openEventFile(event) {
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
  state.eventName = typeof parsed.eventName === "string" ? parsed.eventName : "";
  els.eventNameInput.value = state.eventName;
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
        const importedFile = eventPayloadToFile(cue.file);
        state.files.set(index, importedFile);
        state.settings[index].fileName = importedFile.name;
        state.settings[index].duration = await readAudioDuration(importedFile);
        await putStoredFile(index, importedFile);
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
    card.querySelector(".fade-in-duration").value = setting.fadeInDuration;
    card.querySelector(".fade-enabled").checked = setting.fadeEnabled;
    card.querySelector(".fade-at").value = setting.fadeAt;
    card.querySelector(".fade-duration").value = setting.fadeDuration;
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

function eventPayloadToFile(payload) {
  if (
    !payload ||
    typeof payload.name !== "string" ||
    typeof payload.data !== "string" ||
    payload.data.length === 0
  ) {
    throw new Error("Invalid file payload");
  }
  const bytes = base64ToBytes(payload.data);
  return new File([bytes], payload.name, {
    type: payload.type || "application/octet-stream",
    lastModified: payload.lastModified || Date.now(),
  });
}

function base64ToBytes(base64) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Invalid base64 payload");
  }
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
