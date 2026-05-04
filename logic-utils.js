(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.VowCueLogic = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
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

  function formatTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function validateCueSetting(setting, options = {}) {
    const hasFile = Boolean(options.hasFile);
    const duration = Number(setting?.duration || 0);
    const fadeDuration = clamp(Number(options.fadeDuration || 5), 1, 60);
    const staleFileName = Boolean(setting?.fileName) && !hasFile;
    const fadeInAt = parseTime(setting?.fadeInAt || "0");
    const fadeAt = parseTime(setting?.fadeAt);
    const issues = [];

    if (!hasFile) {
      issues.push(staleFileName ? "Stored file unavailable" : "No file loaded");
    }
    if (hasFile && (!Number.isFinite(duration) || duration <= 0)) {
      issues.push("Duration unavailable");
    }
    if (setting?.fadeInEnabled) {
      if (fadeInAt === null) {
        issues.push("Fade-in time is invalid");
      } else if (duration > 0 && fadeInAt + fadeDuration > duration) {
        issues.push("Fade-in starts too late");
      }
    }
    if (setting?.fadeEnabled) {
      if (fadeAt === null) {
        issues.push("Fade-out time is invalid");
      } else if (duration > 0 && fadeAt + fadeDuration > duration) {
        issues.push("Fade-out ends past file");
      } else if (setting?.fadeInEnabled && fadeInAt !== null && fadeAt < fadeInAt + fadeDuration) {
        issues.push("Fade-out overlaps fade-in");
      }
    }

    return {
      ready: issues.length === 0,
      issues,
      severity: staleFileName || (hasFile && issues.length > 0) ? "error" : issues.length > 0 ? "warning" : "ready",
    };
  }

  function getRemainingTarget({ duration, fading = false, fadeEndsAtElapsed = null, fadeEnabled = false, fadeAt = "", fadeDuration = 5 }) {
    const safeDuration = Math.max(0, Number(duration || 0));
    if (fading && fadeEndsAtElapsed !== null) {
      return clamp(Number(fadeEndsAtElapsed || 0), 0, safeDuration);
    }

    if (!fadeEnabled) return safeDuration;

    const parsedFadeAt = parseTime(fadeAt);
    if (parsedFadeAt === null) return safeDuration;

    return clamp(parsedFadeAt + clamp(Number(fadeDuration || 5), 1, 60), 0, safeDuration);
  }

  return {
    clamp,
    formatTime,
    getRemainingTarget,
    parseTime,
    validateCueSetting,
  };
});
