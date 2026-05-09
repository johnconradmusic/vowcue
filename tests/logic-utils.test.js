const test = require("node:test");
const assert = require("node:assert/strict");

const { compareVersions, getRemainingTarget, isValidEventName, parseTime, validateCueSetting } = require("../logic-utils.js");

test("parseTime accepts operator-friendly mm:ss and hh:mm:ss values", () => {
  assert.equal(parseTime("2:05"), 125);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.equal(parseTime("125"), 125);
});

test("parseTime rejects impossible clock values", () => {
  assert.equal(parseTime("1:75"), null);
  assert.equal(parseTime("1:62:00"), null);
  assert.equal(parseTime("now"), null);
});

test("validateCueSetting requires the actual file to be available", () => {
  const result = validateCueSetting({ fileName: "first-dance.mp3", duration: 180 }, { hasFile: false, fadeDuration: 5 });
  assert.equal(result.ready, false);
  assert.equal(result.severity, "error");
  assert.deepEqual(result.issues, ["Stored file unavailable"]);
});

test("validateCueSetting rejects fade windows that overlap or exceed duration", () => {
  const lateFade = validateCueSetting(
    { fileName: "song.mp3", duration: 30, fadeEnabled: true, fadeAt: "0:28" },
    { hasFile: true, fadeDuration: 5 },
  );
  assert.equal(lateFade.ready, false);
  assert.equal(lateFade.issues[0], "Fade-out ends past file");

  const overlap = validateCueSetting(
    { fileName: "song.mp3", duration: 60, fadeInEnabled: true, fadeInAt: "0:20", fadeEnabled: true, fadeAt: "0:22" },
    { hasFile: true, fadeDuration: 5 },
  );
  assert.equal(overlap.ready, false);
  assert.equal(overlap.issues[0], "Fade-out overlaps fade-in");
});

test("getRemainingTarget includes planned fade duration and fade-now target", () => {
  assert.equal(
    getRemainingTarget({ duration: 180, fadeEnabled: true, fadeAt: "2:00", fadeDuration: 5 }),
    125,
  );
  assert.equal(
    getRemainingTarget({ duration: 180, fading: true, fadeEndsAtElapsed: 43, fadeEnabled: true, fadeAt: "2:00" }),
    43,
  );
});

test("isValidEventName requires a usable event label", () => {
  assert.equal(isValidEventName("Smith / Johnson Wedding"), true);
  assert.equal(isValidEventName("  A "), false);
  assert.equal(isValidEventName(" -- "), false);
});

test("compareVersions handles release tags", () => {
  assert.equal(compareVersions("v0.1.9", "0.1.8"), 1);
  assert.equal(compareVersions("0.1.8", "v0.1.8"), 0);
  assert.equal(compareVersions("0.1.7", "0.1.8"), -1);
});
