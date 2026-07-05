const https = require("https");

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const offline = args.has("--offline") || !live;
const token = process.env.GEMINI_API_KEY || process.env.PLANNY_GEMINI_KEY || "";
const today = process.env.PLANNY_TEST_TODAY || "2026-07-05";
const weekday = "Sunday";
const fromArg = process.argv.find((arg) => arg.startsWith("--from="));
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const fromIndex = fromArg ? Math.max(0, Number(fromArg.split("=")[1]) || 0) : 0;
const limitCount = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 1) : Infinity;

const profileBlock = `
About this user (use it - this is why they trust you):
- Work hours: 09:00-18:00.
- Peak focus window (most productive, least drained): 09:30-12:30.
- Max deep-focus block: 90 minutes. Needs 15 minute breaks between focus blocks.
- Tasks that DRAIN them: grading, admin email, long meetings, debugging without a plan.
- Tasks they can do tired / that energize them: plotting results, reading, tidying notes, quick replies.
- Already scheduled (avoid overlaps): 2026-07-06 10:00 60m Fixed lab meeting; 2026-07-07 14:00 30m Advisor call.

Scheduling rules:
- "Productive slots" / focus blocks go inside the peak window when possible, otherwise within work hours. Never overlap existing items, keep 15 min gaps, cap each block at 90 minutes.
- If the user asks for N slots or blocks, return exactly N activities with kind "focus" and generic titles like "Deep focus slot 1" unless they named the work.
- Never stack draining tasks back to back; alternate with lighter or energizing work, and keep draining tasks out of the late-day low-energy zone.
`;

const cases = [
  {
    id: "weekday-and-saturday-routines",
    text: "I wake up on 7:00 am on weekdays. On Saturdays I wake up at 9:00 am",
    expect: {
      activitiesCount: 2,
      activities: [
        { title: "Wake up", start: "07:00", recurrence: ["MO", "TU", "WE", "TH", "FR"], dateOneOfDays: ["MO", "TU", "WE", "TH", "FR"], locked: false },
        { title: "Wake up", start: "09:00", recurrence: ["SA"], dateDay: "SA", locked: false }
      ]
    }
  },
  {
    id: "plural-wednesday-meeting",
    text: "On Wednesdays I have meeting xxx 9am 30m",
    expect: { activitiesCount: 1, activities: [{ title: "Meeting xxx", date: "2026-07-08", start: "09:00", durationMin: 30, recurrence: ["WE"], locked: true }] }
  },
  {
    id: "singular-wednesday-not-recurring",
    text: "On Wednesday write intro at 2pm for 90m",
    expect: { activitiesCount: 1, activities: [{ title: "Write intro", date: "2026-07-08", start: "14:00", durationMin: 90, recurrence: null, locked: false }] }
  },
  {
    id: "mwf-shortcode",
    text: "Every Mon/Wed/Fri gym 7am 45m",
    expect: { activitiesCount: 1, activities: [{ title: "Gym", start: "07:00", durationMin: 45, recurrence: ["MO", "WE", "FR"], dateDay: "MO", locked: false }] }
  },
  {
    id: "tuesday-thursday-class",
    text: "Tuesdays and Thursdays class at 2pm for 75 minutes",
    expect: { activitiesCount: 1, activities: [{ title: "Class", start: "14:00", durationMin: 75, recurrence: ["TU", "TH"], locked: true }] }
  },
  {
    id: "weekend-routine",
    text: "On weekends meal prep at 11am for 2h",
    expect: { activitiesCount: 1, activities: [{ title: "Meal prep", start: "11:00", durationMin: 120, recurrence: ["SA", "SU"], dateDay: "SU", locked: false }] }
  },
  {
    id: "daily-medication",
    text: "take meds every day at 8am",
    expect: { activitiesCount: 1, activities: [{ title: "Take meds", date: today, start: "08:00", recurrenceFrequency: "daily", locked: false }] }
  },
  {
    id: "daily-review",
    text: "daily review notes at 6pm 20m",
    expect: { activitiesCount: 1, activities: [{ title: "Review notes", date: today, start: "18:00", durationMin: 20, recurrenceFrequency: "daily" }] }
  },
  {
    id: "project-branch-tags",
    text: "tomorrow 9:30 write intro 90m #project:gesture #branch:paper",
    expect: { activitiesCount: 1, activities: [{ title: "Write intro", date: "2026-07-06", start: "09:30", durationMin: 90, project: "Gesture", branch: "Paper" }] }
  },
  {
    id: "dentist-fixed",
    text: "Dentist appointment tomorrow at 4pm for half hour",
    expect: { activitiesCount: 1, activities: [{ title: "Dentist appointment", date: "2026-07-06", start: "16:00", durationMin: 30, locked: true, kind: "routine" }] }
  },
  {
    id: "exam-immovable",
    text: "Can't move exam Friday 10am 2h",
    expect: { activitiesCount: 1, activities: [{ title: "Exam", date: "2026-07-10", start: "10:00", durationMin: 120, locked: true }] }
  },
  {
    id: "call-fixed",
    text: "call mom tonight 20m",
    expect: { activitiesCount: 1, activities: [{ title: "Call mom", date: today, start: "20:00", durationMin: 20, kind: "personal", locked: true }] }
  },
  {
    id: "walk-flexible",
    text: "go for a walk this evening 30m",
    expect: { activitiesCount: 1, activities: [{ title: "Walk", date: today, start: "18:00", durationMin: 30, kind: "personal", locked: false }] }
  },
  {
    id: "read-paper-morning",
    text: "read paper tomorrow morning for one hour",
    expect: { activitiesCount: 1, activities: [{ title: "Read paper", date: "2026-07-06", start: "09:30", durationMin: 60, kind: "focus", locked: false }] }
  },
  {
    id: "admin-email",
    text: "send admin email today 4pm 15m",
    expect: { activitiesCount: 1, activities: [{ title: "Send admin email", date: today, start: "16:00", durationMin: 15, kind: "admin", locked: false }] }
  },
  {
    id: "weekly-class-monday",
    text: "class every Monday 11am",
    expect: { activitiesCount: 1, activities: [{ title: "Class", date: "2026-07-06", start: "11:00", recurrence: ["MO"], locked: true }] }
  },
  {
    id: "monday-wednesday-workout",
    text: "workout on Mondays and Wednesdays at 6am",
    expect: { activitiesCount: 1, activities: [{ title: "Workout", start: "06:00", recurrence: ["MO", "WE"], locked: false }] }
  },
  {
    id: "singular-monday-workout",
    text: "on Monday workout at 6am",
    expect: { activitiesCount: 1, activities: [{ title: "Workout", date: "2026-07-06", start: "06:00", recurrence: null, locked: false }] }
  },
  {
    id: "next-sunday",
    text: "next Sunday family lunch at noon",
    expect: { activitiesCount: 1, activities: [{ title: "Family lunch", date: "2026-07-12", start: "12:00", recurrence: null }] }
  },
  {
    id: "weekday-standup-duration-first",
    text: "half hour standup every weekday 10am",
    expect: { activitiesCount: 1, activities: [{ title: "Standup", start: "10:00", durationMin: 30, recurrence: ["MO", "TU", "WE", "TH", "FR"], locked: true }] }
  },
  {
    id: "sleep-daily",
    text: "sleep at 11pm daily",
    expect: { activitiesCount: 1, activities: [{ title: "Sleep", start: "23:00", recurrenceFrequency: "daily", kind: "personal", locked: false }] }
  },
  {
    id: "three-routines-one-dump",
    text: "I wake up at 7am on weekdays; meditate every day at 7:15 for 10m; On Saturdays wake up at 9am",
    expect: { activitiesCount: 3, activities: [{ title: "Wake up", start: "07:00", recurrence: ["MO", "TU", "WE", "TH", "FR"] }, { title: "Meditate", start: "07:15", durationMin: 10, recurrenceFrequency: "daily" }, { title: "Wake up", start: "09:00", recurrence: ["SA"] }] }
  },
  {
    id: "four-productive-slots",
    text: "schedule four productive slots tomorrow",
    expect: { activitiesCount: 4, allKind: "focus" }
  },
  {
    id: "reschedule-command-only",
    text: "move write intro to 10am",
    expect: { activitiesCount: 0, notesCount: 0 }
  },
  {
    id: "reschedule-fixed-command-only",
    text: "reschedule dentist to Friday",
    expect: { activitiesCount: 0, notesCount: 0 }
  },
  {
    id: "decision-note",
    text: "decision: keep calibration optional #project:gesture",
    expect: { activitiesCount: 0, notesCount: 1, notes: [{ section: "open_decisions", project: "Gesture", contains: "calibration optional" }] }
  },
  {
    id: "blocked-note",
    text: "blocked: waiting for advisor reply on appendix #project:gesture",
    expect: { activitiesCount: 0, notesCount: 1, notes: [{ section: "blocked_by", project: "Gesture", priorityAtLeast: 3 }] }
  },
  {
    id: "future-idea-note",
    text: "idea: next week try a lighter dashboard for check-ins",
    expect: { activitiesCount: 0, notesCount: 1, notes: [{ section: "future_ideas", contains: "dashboard" }] }
  },
  {
    id: "meeting-note-not-event",
    text: "meeting: advisor said make calibration optional and show ablation",
    expect: { activitiesCount: 0, notesCount: 1, notes: [{ section: "meeting_notes", contains: "calibration optional" }] }
  },
  {
    id: "someday-note",
    text: "someday: build mobile widgets for mood tracking",
    expect: { activitiesCount: 0, notesCount: 1, notes: [{ section: "someday_not_now", contains: "mobile widgets" }] }
  },
  {
    id: "mixed-note-and-task",
    text: "decision: keep the Firebase setup user-owned. Tomorrow 3pm update README 45m",
    expect: { activitiesCount: 1, notesCount: 1, activities: [{ title: "Update README", date: "2026-07-06", start: "15:00", durationMin: 45 }], notes: [{ section: "open_decisions" }] }
  },
  {
    id: "two-events-locking",
    text: "Thursday 10am seminar on sensing 1h. After that prepare slides for 90m",
    expect: { activitiesCount: 2, activities: [{ title: "Seminar on sensing", date: "2026-07-09", start: "10:00", locked: true }, { title: "Prepare slides", durationMin: 90, locked: false }] }
  },
  {
    id: "interview-next-wednesday",
    text: "interview next Wednesday 3pm 45m",
    expect: { activitiesCount: 1, activities: [{ title: "Interview", date: "2026-07-08", start: "15:00", durationMin: 45, locked: true }] }
  },
  {
    id: "doctor-friday",
    text: "doctor appointment on Friday at 5pm",
    expect: { activitiesCount: 1, activities: [{ title: "Doctor appointment", date: "2026-07-10", start: "17:00", locked: true }] }
  },
  {
    id: "weekly-update",
    text: "every Friday send weekly update 4pm 15m",
    expect: { activitiesCount: 1, activities: [{ title: "Send weekly update", date: "2026-07-10", start: "16:00", durationMin: 15, recurrence: ["FR"], kind: "admin", locked: false }] }
  },
  {
    id: "fridays-lab-journal",
    text: "on Fridays write lab journal 30m at 9am",
    expect: { activitiesCount: 1, activities: [{ title: "Write lab journal", start: "09:00", durationMin: 30, recurrence: ["FR"], locked: false }] }
  },
  {
    id: "singular-friday-lab-journal",
    text: "on Friday write lab journal 30m at 9am",
    expect: { activitiesCount: 1, activities: [{ title: "Write lab journal", date: "2026-07-10", start: "09:00", durationMin: 30, recurrence: null }] }
  },
  {
    id: "weekly-team-sync",
    text: "weekly team sync Tuesday 10am",
    expect: { activitiesCount: 1, activities: [{ title: "Team sync", start: "10:00", recurrence: ["TU"], locked: true }] }
  },
  {
    id: "grocery-one-off",
    text: "buy groceries Saturday 10am",
    expect: { activitiesCount: 1, activities: [{ title: "Buy groceries", date: "2026-07-11", start: "10:00", recurrence: null, locked: false }] }
  },
  {
    id: "flight-fixed",
    text: "flight to Delhi Monday 6am",
    expect: { activitiesCount: 1, activities: [{ title: "Flight to Delhi", date: "2026-07-06", start: "06:00", locked: true }] }
  },
  {
    id: "water-plants-weekend",
    text: "water plants weekends 9am",
    expect: { activitiesCount: 1, activities: [{ title: "Water plants", start: "09:00", recurrence: ["SA", "SU"], locked: false }] }
  },
  {
    id: "clean-desk",
    text: "clean desk at 6pm",
    expect: { activitiesCount: 1, activities: [{ title: "Clean desk", date: today, start: "18:00", locked: false }] }
  },
  {
    id: "quarter-hour-breathing",
    text: "quarter hour breathing every day at noon",
    expect: { activitiesCount: 1, activities: [{ title: "Breathing", start: "12:00", durationMin: 15, recurrenceFrequency: "daily" }] }
  },
  {
    id: "hour-and-half-deep-work",
    text: "one hour and a half deep work tomorrow morning",
    expect: { activitiesCount: 1, activities: [{ title: "Deep work", date: "2026-07-06", durationMin: 90, kind: "focus" }] }
  },
  {
    id: "tomorrow-night",
    text: "tomorrow night review poster 40m",
    expect: { activitiesCount: 1, activities: [{ title: "Review poster", date: "2026-07-06", start: "20:00", durationMin: 40 }] }
  },
  {
    id: "fixed-immovable-phrase",
    text: "fixed lab meeting Monday 10am for 1 hour",
    expect: { activitiesCount: 1, activities: [{ title: "Lab meeting", date: "2026-07-06", start: "10:00", durationMin: 60, locked: true }] }
  },
  {
    id: "movable-phrase-overrides-meeting-word",
    text: "movable meeting prep Monday 1pm 45m",
    expect: { activitiesCount: 1, activities: [{ title: "Meeting prep", date: "2026-07-06", start: "13:00", durationMin: 45, locked: false }] }
  },
  {
    id: "ruok-project-inference",
    text: "tomorrow 5pm review RUOK bathroom notes 30m",
    expect: { activitiesCount: 1, activities: [{ title: "Review RUOK bathroom notes", project: "RUOK", date: "2026-07-06", start: "17:00" }] }
  },
  {
    id: "kgp-project-inference",
    text: "Wednesday 11am email KGP collaborator 20m",
    expect: { activitiesCount: 1, activities: [{ title: "Email KGP collaborator", project: "KGP", date: "2026-07-08", start: "11:00", kind: "admin" }] }
  },
  {
    id: "calibration-branch-inference",
    text: "Friday 2pm debug calibration pipeline 90m #project:gesture",
    expect: { activitiesCount: 1, activities: [{ title: "Debug calibration pipeline", project: "Gesture", branch: "Calibration", date: "2026-07-10", start: "14:00" }] }
  },
  {
    id: "paper-branch-inference",
    text: "tomorrow 10am revise paper submission intro 1h #project:gesture",
    expect: { activitiesCount: 1, activities: [{ title: "Revise paper submission intro", project: "Gesture", branch: "Paper submission", date: "2026-07-06", start: "10:00" }] }
  },
  {
    id: "dataset-branch-inference",
    text: "Tuesday 3pm clean dataset labels 2h #project:gesture",
    expect: { activitiesCount: 1, activities: [{ title: "Clean dataset labels", branch: "Dataset", date: "2026-07-07", start: "15:00", durationMin: 120 }] }
  },
  {
    id: "ambiguous-question",
    text: "plan it sometime",
    expect: { activitiesCount: 0, notesCount: 0, question: true }
  }
];

function dayCode(dateKey) {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(`${dateKey}T00:00:00`).getDay()];
}

function normalizeByDay(recurrence) {
  if (!recurrence || !recurrence.byDay) return [];
  const days = Array.isArray(recurrence.byDay) ? recurrence.byDay : String(recurrence.byDay).split(",");
  return days.map((day) => String(day).trim().toUpperCase()).filter(Boolean);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function titleNorm(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function includesNorm(value, needle) {
  return titleNorm(value).includes(titleNorm(needle));
}

function findActivity(activities, expected) {
  return activities.find((activity) => {
    if (expected.title && !includesNorm(activity.title, expected.title)) return false;
    if (expected.start && activity.start !== expected.start) return false;
    if (expected.date && activity.date !== expected.date) return false;
    if (expected.recurrence === null && activity.recurrence) return false;
    if (Array.isArray(expected.recurrence) && !sameSet(normalizeByDay(activity.recurrence), expected.recurrence)) return false;
    if (expected.recurrenceFrequency && (!activity.recurrence || activity.recurrence.frequency !== expected.recurrenceFrequency)) return false;
    return true;
  });
}

function validateCase(testCase, parsed) {
  const failures = [];
  const activities = Array.isArray(parsed.activities) ? parsed.activities : [];
  const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
  const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
  const expect = testCase.expect || {};

  if (Number.isInteger(expect.activitiesCount) && activities.length !== expect.activitiesCount) {
    failures.push(`expected ${expect.activitiesCount} activities, got ${activities.length}`);
  }
  if (Number.isInteger(expect.notesCount) && notes.length !== expect.notesCount) {
    failures.push(`expected ${expect.notesCount} notes, got ${notes.length}`);
  }
  if (expect.question && !question) failures.push("expected a clarifying question");
  if (expect.allKind && activities.some((activity) => activity.kind !== expect.allKind)) {
    failures.push(`expected all activities kind ${expect.allKind}`);
  }

  for (const expected of expect.activities || []) {
    const activity = findActivity(activities, expected);
    if (!activity) {
      failures.push(`missing activity ${JSON.stringify(expected)}`);
      continue;
    }
    if (expected.durationMin !== undefined && Number(activity.durationMin) !== expected.durationMin) failures.push(`${expected.title} duration expected ${expected.durationMin}, got ${activity.durationMin}`);
    if (expected.kind && activity.kind !== expected.kind) failures.push(`${expected.title} kind expected ${expected.kind}, got ${activity.kind}`);
    if (expected.locked !== undefined && Boolean(activity.locked) !== expected.locked) failures.push(`${expected.title} locked expected ${expected.locked}, got ${activity.locked}`);
    if (expected.project && !includesNorm(activity.project, expected.project)) failures.push(`${expected.title} project expected ${expected.project}, got ${activity.project}`);
    if (expected.branch && !includesNorm(activity.branch, expected.branch)) failures.push(`${expected.title} branch expected ${expected.branch}, got ${activity.branch}`);
    if (expected.recurrence === null && activity.recurrence) failures.push(`${expected.title} should not recur`);
    if (Array.isArray(expected.recurrence) && !sameSet(normalizeByDay(activity.recurrence), expected.recurrence)) {
      failures.push(`${expected.title} recurrence expected ${expected.recurrence.join(",")}, got ${JSON.stringify(activity.recurrence)}`);
    }
    if (expected.dateDay && dayCode(activity.date) !== expected.dateDay) failures.push(`${expected.title} expected date weekday ${expected.dateDay}, got ${activity.date}`);
    if (expected.dateOneOfDays && !expected.dateOneOfDays.includes(dayCode(activity.date))) failures.push(`${expected.title} landed on invalid date ${activity.date}`);
    if (titleNorm(activity.title).length > 80 || includesNorm(activity.title, testCase.text)) failures.push(`${expected.title} title looks like raw prompt: ${activity.title}`);
  }

  for (const expected of expect.notes || []) {
    const note = notes.find((candidate) => {
      if (expected.section && candidate.section !== expected.section) return false;
      if (expected.project && !includesNorm(candidate.project, expected.project)) return false;
      if (expected.contains && !includesNorm(candidate.text, expected.contains)) return false;
      return true;
    });
    if (!note) {
      failures.push(`missing note ${JSON.stringify(expected)}`);
      continue;
    }
    if (expected.priorityAtLeast && Number(note.priority) < expected.priorityAtLeast) failures.push(`note priority expected >= ${expected.priorityAtLeast}, got ${note.priority}`);
  }

  return failures;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error) {
  return /Gemini HTTP (500|502|503|504)|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error && error.message ? error.message : "");
}

async function postJson(url, payload, options = {}) {
  const attempts = options.attempts || 4;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await postJsonOnce(url, payload);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableGeminiError(error)) break;
      await wait(Math.min(8000, 750 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

function postJsonOnce(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Gemini HTTP ${response.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function runLive() {
  if (!token) throw new Error("Set GEMINI_API_KEY or PLANNY_GEMINI_KEY to run the live Gemini suite.");
  const { buildGeminiPrompt, extractGeminiJsonBlock, geminiModel } = await import("../src/gemini-parser.js");
  const failures = [];
  const selectedCases = cases.slice(fromIndex, Number.isFinite(limitCount) ? fromIndex + limitCount : undefined);
  for (const [offset, testCase] of selectedCases.entries()) {
    const prompt = buildGeminiPrompt({
      text: testCase.text,
      today,
      weekday,
      profileBlock,
      allowQuestion: testCase.expect && testCase.expect.question
    });
    let data;
    try {
      data = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(token)}`, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      }, { attempts: 5 });
    } catch (error) {
      failures.push({ id: testCase.id, index: fromIndex + offset, failures: [error.message] });
      process.stdout.write("E");
      if (/Gemini HTTP 429/.test(error.message)) break;
      continue;
    }
    const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    let parsed;
    try {
      parsed = JSON.parse(extractGeminiJsonBlock(raw || ""));
    } catch (error) {
      failures.push({ id: testCase.id, index: fromIndex + offset, failures: [`invalid JSON: ${error.message}`], raw });
      continue;
    }
    const testFailures = validateCase(testCase, parsed);
    if (testFailures.length) failures.push({ id: testCase.id, index: fromIndex + offset, failures: testFailures, parsed });
    process.stdout.write(testFailures.length ? "F" : ".");
    await wait(350);
  }
  process.stdout.write("\n");
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    throw new Error(`${failures.length}/${selectedCases.length} Gemini parser cases failed for selected range.`);
  }
  console.log(`Live Gemini parser suite passed: ${selectedCases.length} adversarial cases.`);
}

async function runOffline() {
  const { buildGeminiPrompt } = await import("../src/gemini-parser.js");
  if (cases.length < 50) throw new Error(`Suite is too small: ${cases.length} cases`);
  const ids = new Set();
  for (const testCase of cases) {
    if (!testCase.id || ids.has(testCase.id)) throw new Error(`Bad or duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.text || !testCase.expect) throw new Error(`Case ${testCase.id} is missing text or expect`);
  }
  const prompt = buildGeminiPrompt({ text: cases[0].text, today, weekday, profileBlock, allowQuestion: true });
  for (const phrase of [
    "Return only JSON",
    "Never copy the whole prompt into a title",
    "reschedule/edit command",
    "weekdays",
    "weekends",
    "Multi-day routines",
    "recurrence.byDay",
    "Fixed/locked",
    "Productive slots",
    "Notes schema"
  ]) {
    if (!prompt.includes(phrase)) throw new Error(`Prompt missing critical phrase: ${phrase}`);
  }
  const validatorSmoke = [
    {
      activities: [
        { title: "Wake up", date: "2026-07-06", start: "07:00", recurrence: { frequency: "weekly", byDay: ["MO", "TU", "WE", "TH", "FR"] }, locked: false },
        { title: "Wake up", date: "2026-07-11", start: "09:00", recurrence: { frequency: "weekly", byDay: "SA" }, locked: false }
      ],
      notes: [],
      question: ""
    },
    {
      activities: [],
      notes: [{ project: "Gesture", branch: "Main", section: "open_decisions", text: "keep calibration optional", priority: 3 }],
      question: ""
    }
  ];
  const smokeFailures = [
    validateCase(cases[0], validatorSmoke[0]),
    validateCase(cases.find((item) => item.id === "decision-note"), validatorSmoke[1])
  ].flat();
  if (smokeFailures.length) throw new Error(`Validator smoke failed: ${smokeFailures.join("; ")}`);
  console.log(`Offline Gemini suite check passed: ${cases.length} adversarial cases defined. Live API run skipped.`);
}

(async () => {
  if (live && !token) throw new Error("Set GEMINI_API_KEY or PLANNY_GEMINI_KEY to run --live.");
  if (live) await runLive();
  else if (offline) await runOffline();
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
