import { initFirebase, saveCloudState, loadCloudState, signIn, signOut } from "./firebase.js";

const storageKey = "daypilot-state-v2";
const firebaseKey = "daypilot-firebase-config";
const geminiKey = "daypilot-gemini-key";

const blankState = {
  view: "day",
  route: "home",
  mood: {
    label: "Okay",
    energy: 55,
    stress: 35
  },
  settings: {
    parserMode: "manual",
    workDone: 0,
    exhaustion: 20
  },
  activities: [],
  checkins: {},
  chatDraft: "",
  activeModal: null,
  editingId: null,
  lastMessage: "Blank slate ready. Add a task or dump into chat."
};

let state = loadState();
let firebaseRuntime = null;

boot();

async function boot() {
  registerServiceWorker();
  firebaseRuntime = await initFirebase(readFirebaseConfig());
  if (firebaseRuntime.ready && firebaseRuntime.user) {
    const cloud = await loadCloudState(firebaseRuntime);
    if (cloud) {
      state = normalizeState(cloud);
      saveLocal();
    }
  }
  render();
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    return normalizeState(stored || blankState);
  } catch {
    return normalizeState(blankState);
  }
}

function normalizeState(input) {
  const base = JSON.parse(JSON.stringify(blankState));
  const next = { ...base, ...(input || {}) };
  next.mood = { ...base.mood, ...(input && input.mood ? input.mood : {}) };
  next.settings = { ...base.settings, ...(input && input.settings ? input.settings : {}) };
  next.activities = Array.isArray(next.activities) ? next.activities : [];
  next.checkins = next.checkins && typeof next.checkins === "object" ? next.checkins : {};
  return next;
}

function saveLocal() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function persist(syncCloud = true) {
  saveLocal();
  if (syncCloud && firebaseRuntime && firebaseRuntime.ready && firebaseRuntime.user) {
    saveCloudState(firebaseRuntime, state).catch(() => toast("Saved locally. Firebase sync did not complete."));
  }
}

function routeName() {
  const hashRoute = location.hash.replace("#/", "");
  const raw = hashRoute || location.pathname.split("/").filter(Boolean).pop() || "today";
  if (raw === "checkin" || raw === "stats") return "stats";
  if (raw === "settings") return "settings";
  return "home";
}

function routePath(route) {
  if (route === "stats") return "./checkin";
  if (route === "settings") return "./settings";
  return "./today";
}

function navigate(route) {
  history.pushState({}, "", routePath(route));
  state.route = route;
  render();
}

window.addEventListener("popstate", render);

function render() {
  state.route = routeName();
  document.querySelector("#app").innerHTML = `
    <main class="app">
      ${renderHeader()}
      ${state.route === "stats" ? renderStatsPage() : state.route === "settings" ? renderSettingsPage() : renderHomePage()}
    </main>
    ${renderModal()}
    <div class="toast hidden" role="status" aria-live="polite"></div>
  `;
  bindEvents();
}

function renderHeader() {
  return `
    <header class="topbar">
      <div>
        <h1>DayPilot</h1>
        <p>${state.activities.length ? `${state.activities.length} planned activities` : "A blank slate for the day."}</p>
      </div>
      <nav class="topnav" aria-label="Main navigation">
        <button class="${state.route === "home" ? "active" : ""}" data-route="home">Plan</button>
        <button class="${state.route === "stats" ? "active" : ""}" data-route="stats">Stats</button>
        <button class="${state.route === "settings" ? "active" : ""}" data-route="settings">Settings</button>
      </nav>
    </header>
  `;
}

function renderHomePage() {
  return `
    <section class="home">
      ${renderMoodPanel()}
      ${renderFirebaseBanner()}
      <section class="planner-panel">
        <div class="planner-head">
          <div class="segmented" role="tablist" aria-label="Calendar view">
            ${["day", "week", "month"].map((view) => `<button class="${state.view === view ? "active" : ""}" data-view="${view}">${titleCase(view)}</button>`).join("")}
          </div>
          <div class="quick-actions">
            <button class="icon-button primary" data-open-modal="chat" aria-label="Open chat dump">Chat</button>
            <button class="icon-button" data-open-modal="task" aria-label="Add task">+</button>
          </div>
        </div>
        ${renderActivityView()}
      </section>
    </section>
  `;
}

function renderMoodPanel() {
  return `
    <section class="mood-panel" aria-label="Mood tracking">
      <div>
        <h2>Mood</h2>
        <p>${escapeHtml(state.mood.label)} - energy ${state.mood.energy}% - stress ${state.mood.stress}%</p>
      </div>
      <label>
        Mood
        <input data-mood="label" value="${escapeAttr(state.mood.label)}" aria-label="Mood label">
      </label>
      <label>
        Energy
        <input type="range" min="0" max="100" value="${state.mood.energy}" data-mood="energy" aria-label="Energy">
      </label>
      <label>
        Stress
        <input type="range" min="0" max="100" value="${state.mood.stress}" data-mood="stress" aria-label="Stress">
      </label>
    </section>
  `;
}

function renderFirebaseBanner() {
  if (firebaseRuntime && firebaseRuntime.ready && firebaseRuntime.user) {
    return `
      <section class="sync-banner good">
        <strong>Firebase sync on</strong>
        <span>${escapeHtml(firebaseRuntime.user.email || "Signed in")}</span>
      </section>
    `;
  }
  if (firebaseRuntime && firebaseRuntime.ready) {
    return `
      <section class="sync-banner">
        <strong>Firebase configured, sign-in pending.</strong>
        <span>Cloud sync, cross-device restore, and account backup start after Google sign-in.</span>
        <button data-action="google-signin">Sign in</button>
      </section>
    `;
  }
  return `
    <section class="sync-banner warn">
      <strong>Firebase is not configured.</strong>
      <span>No cloud sync, no cross-device restore, no account backup, and no synced settings yet.</span>
      <button data-route="settings">Set up</button>
    </section>
  `;
}

function renderActivityView() {
  if (!state.activities.length) {
    return `
      <div class="empty-state">
        <h2>No activities yet</h2>
        <p>Use Chat for a dump, or + for a manual task.</p>
      </div>
    `;
  }
  if (state.view === "week") return renderWeekView();
  if (state.view === "month") return renderMonthView();
  return renderDayView();
}

function renderDayView() {
  const today = todayKey();
  const items = sortedActivities().filter((activity) => activity.date === today);
  return renderActivityList(items.length ? items : sortedActivities(), "day-list");
}

function renderWeekView() {
  const days = weekKeys();
  return `
    <div class="week-view">
      ${days.map((day) => `
        <section class="day-column">
          <h3>${formatDay(day)}</h3>
          ${renderActivityList(sortedActivities().filter((activity) => activity.date === day), "compact-list")}
        </section>
      `).join("")}
    </div>
  `;
}

function renderMonthView() {
  const grouped = groupByDate(sortedActivities());
  const days = Object.keys(grouped).sort();
  return `
    <div class="month-view">
      ${days.length ? days.map((day) => `
        <section>
          <h3>${formatDay(day)}</h3>
          ${renderActivityList(grouped[day], "compact-list")}
        </section>
      `).join("") : `<p class="muted">Nothing scheduled this month.</p>`}
    </div>
  `;
}

function renderActivityList(items, className) {
  if (!items.length) return `<p class="muted">Free.</p>`;
  return `
    <div class="${className}">
      ${items.map((activity) => `
        <button class="activity-card ${escapeAttr(activity.kind)}" data-edit="${activity.id}">
          <span>${formatTime(activity.start)}</span>
          <strong>${escapeHtml(activity.title)}</strong>
          <em>${activity.durationMin}m - ${escapeHtml(activity.status || "planned")}</em>
        </button>
      `).join("")}
    </div>
  `;
}

function renderStatsPage() {
  const completeCount = state.activities.filter((activity) => activity.status === "done").length;
  const count = state.activities.length;
  const computed = count ? Math.round((completeCount / count) * 100) : 0;
  const workDone = Number(state.settings.workDone || computed);
  const exhaustion = Number(state.settings.exhaustion || 0);
  return `
    <section class="stats-page">
      <div class="page-head">
        <h2>Accountability</h2>
        <p>Not guilt. Just capacity data.</p>
      </div>
      <section class="metric-grid">
        <div class="metric-card">
          <span>Work done</span>
          <strong>${workDone}%</strong>
          <input type="range" min="0" max="100" value="${workDone}" data-setting="workDone" aria-label="Work done percentage">
        </div>
        <div class="metric-card warm">
          <span>Exhaustion</span>
          <strong>${exhaustion}%</strong>
          <input type="range" min="0" max="100" value="${exhaustion}" data-setting="exhaustion" aria-label="Exhaustion percentage">
        </div>
        <div class="metric-card calm">
          <span>Completed</span>
          <strong>${completeCount}/${count}</strong>
          <p>${count ? "Tune tomorrow from what actually happened." : "Add tasks first, then check in here."}</p>
        </div>
      </section>
      <section class="planner-panel">
        <h3>Activity check-in</h3>
        ${state.activities.length ? state.activities.map((activity) => `
          <article class="check-row">
            <div>
              <strong>${escapeHtml(activity.title)}</strong>
              <span>${formatDate(activity.date)} ${formatTime(activity.start)}</span>
            </div>
            <div class="status-buttons">
              ${["done", "partial", "missed"].map((status) => `<button class="${activity.status === status ? "active" : ""}" data-status="${status}" data-status-id="${activity.id}">${titleCase(status)}</button>`).join("")}
            </div>
          </article>
        `).join("") : `<p class="muted">No activities to check in yet.</p>`}
      </section>
    </section>
  `;
}

function renderSettingsPage() {
  const firebaseConfig = localStorage.getItem(firebaseKey) || "";
  const token = localStorage.getItem(geminiKey) || "";
  return `
    <section class="settings-page">
      <div class="page-head">
        <h2>Settings</h2>
        <p>Firebase config and Gemini token stay in this browser. App settings sync after Firebase sign-in.</p>
      </div>
      <section class="settings-card">
        <h3>Firebase sync</h3>
        <p class="muted">Create a Firebase Web App, copy its config object, and paste JSON here. Do not commit personal Firebase config to the repo.</p>
        <textarea class="code-input" data-config="firebase" placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'>${escapeHtml(firebaseConfig)}</textarea>
        <div class="button-row">
          <button class="primary" data-action="save-firebase">Save Firebase config</button>
          <button data-action="google-signin">${firebaseRuntime && firebaseRuntime.user ? "Switch account" : "Google sign-in"}</button>
          <button data-action="google-signout">Sign out</button>
        </div>
      </section>
      <section class="settings-card" id="token">
        <h3>Gemini token</h3>
        <p class="muted">Needed only for Gemini chat parsing. No-LLM chat works without it.</p>
        <input type="password" data-secret="gemini" value="${escapeAttr(token)}" placeholder="Gemini API key">
        <div class="button-row">
          <button class="primary" data-action="save-gemini">Save token</button>
          <button data-action="clear-gemini">Clear token</button>
        </div>
      </section>
      <section class="settings-card">
        <h3>Synced app settings</h3>
        <label>
          Default chat mode
          <select data-setting="parserMode">
            <option value="manual" ${state.settings.parserMode === "manual" ? "selected" : ""}>No-LLM</option>
            <option value="gemini" ${state.settings.parserMode === "gemini" ? "selected" : ""}>Gemini</option>
          </select>
        </label>
      </section>
    </section>
  `;
}

function renderModal() {
  if (state.activeModal === "chat") return renderChatModal();
  if (state.activeModal === "task") return renderTaskModal();
  return "";
}

function renderChatModal() {
  const hasToken = Boolean(localStorage.getItem(geminiKey));
  const mode = state.settings.parserMode;
  return `
    <div class="modal-backdrop" role="presentation" data-close-modal="true">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Chat dump">
        <header>
          <h2>Chat dump</h2>
          <button data-close-modal="true" aria-label="Close chat">Close</button>
        </header>
        <div class="segmented">
          <button class="${mode === "manual" ? "active" : ""}" data-chat-mode="manual">No-LLM</button>
          <button class="${mode === "gemini" ? "active" : ""}" data-chat-mode="gemini">Gemini</button>
        </div>
        ${mode === "gemini" && !hasToken ? `
          <div class="sync-banner warn">
            <strong>Gemini token missing.</strong>
            <span>Add a token to use natural-language parsing.</span>
            <button data-action="token-settings">Open token settings</button>
          </div>
        ` : ""}
        <textarea data-chat-input placeholder="Dump tasks, routines, edits, or reschedule requests. Example: tomorrow 9:30 write intro 90m"></textarea>
        <div class="button-row">
          <button class="primary" data-action="submit-chat">Add from chat</button>
          <button data-close-modal="true">Cancel</button>
        </div>
      </section>
    </div>
  `;
}

function renderTaskModal() {
  const editing = getEditingActivity();
  const activity = editing || emptyActivity();
  return `
    <div class="modal-backdrop" role="presentation" data-close-modal="true">
      <section class="modal" role="dialog" aria-modal="true" aria-label="${editing ? "Edit activity" : "Add activity"}">
        <header>
          <h2>${editing ? "Edit activity" : "Add activity"}</h2>
          <button data-close-modal="true" aria-label="Close task editor">Close</button>
        </header>
        <form data-form="task">
          <label>Title <input name="title" required value="${escapeAttr(activity.title)}"></label>
          <div class="form-grid">
            <label>Date <input type="date" name="date" value="${escapeAttr(activity.date)}"></label>
            <label>Start <input type="time" name="start" value="${escapeAttr(activity.start)}"></label>
            <label>Minutes <input type="number" min="5" step="5" name="durationMin" value="${activity.durationMin}"></label>
            <label>Type
              <select name="kind">
                ${["focus", "admin", "routine", "personal"].map((kind) => `<option value="${kind}" ${activity.kind === kind ? "selected" : ""}>${titleCase(kind)}</option>`).join("")}
              </select>
            </label>
          </div>
          <label>Reschedule prompt or note <textarea name="note" placeholder="Move this after lunch, make it lighter, split into 25m...">${escapeHtml(activity.note || "")}</textarea></label>
          <div class="button-row">
            <button class="primary" type="submit">${editing ? "Save changes" : "Add task"}</button>
            ${editing ? `<button class="danger" type="button" data-action="delete-activity">Delete</button>` : ""}
            <button type="button" data-close-modal="true">Cancel</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.route));
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-mood]").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.mood;
      state.mood[key] = key === "label" ? input.value : Number(input.value);
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-open-modal]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeModal = button.dataset.openModal;
      state.editingId = null;
      render();
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target !== element && element.classList.contains("modal-backdrop")) return;
      state.activeModal = null;
      state.editingId = null;
      render();
    });
  });

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingId = button.dataset.edit;
      state.activeModal = "task";
      render();
    });
  });

  document.querySelectorAll("[data-chat-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.settings.parserMode = button.dataset.chatMode;
      persist();
      render();
    });
  });

  const chatSubmit = document.querySelector("[data-action='submit-chat']");
  if (chatSubmit) chatSubmit.addEventListener("click", submitChat);
  const taskForm = document.querySelector("[data-form='task']");
  if (taskForm) taskForm.addEventListener("submit", submitTaskForm);

  document.querySelectorAll("[data-setting]").forEach((input) => {
    input.addEventListener("input", () => {
      state.settings[input.dataset.setting] = input.type === "range" ? Number(input.value) : input.value;
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-status-id]").forEach((button) => {
    button.addEventListener("click", () => {
      updateActivity(button.dataset.statusId, { status: button.dataset.status });
      state.lastMessage = "Check-in saved.";
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button.dataset.action));
  });
}

async function handleAction(action) {
  if (action === "token-settings") {
    state.activeModal = null;
    navigate("settings");
    setTimeout(() => {
      const tokenPanel = document.querySelector("#token");
      if (tokenPanel) tokenPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
    return;
  }
  if (action === "save-firebase") {
    saveFirebaseConfig();
    return;
  }
  if (action === "save-gemini") {
    localStorage.setItem(geminiKey, document.querySelector("[data-secret='gemini']").value.trim());
    toast("Gemini token saved locally.");
    return;
  }
  if (action === "clear-gemini") {
    localStorage.removeItem(geminiKey);
    render();
    return;
  }
  if (action === "google-signin") {
    try {
      await signIn(firebaseRuntime);
      firebaseRuntime = await initFirebase(readFirebaseConfig());
      persist();
      render();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "google-signout") {
    try {
      await signOut(firebaseRuntime);
      firebaseRuntime.user = null;
      render();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "delete-activity") {
    state.activities = state.activities.filter((activity) => activity.id !== state.editingId);
    state.activeModal = null;
    state.editingId = null;
    state.lastMessage = "Activity deleted.";
    persist();
    render();
  }
}

async function submitChat() {
  const input = document.querySelector("[data-chat-input]");
  const text = input.value.trim();
  if (!text) return;
  const mode = state.settings.parserMode;
  const token = localStorage.getItem(geminiKey);
  if (mode === "gemini" && !token) {
    toast("Add a Gemini token first.");
    return;
  }
  let activities = [];
  if (mode === "gemini") {
    activities = await parseWithGemini(text, token).catch(() => parseNoLlm(text));
  } else {
    activities = parseNoLlm(text);
  }
  state.activities = [...state.activities, ...activities];
  state.activeModal = null;
  state.lastMessage = `${activities.length} item${activities.length === 1 ? "" : "s"} added from chat.`;
  persist();
  render();
}

function submitTaskForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const activity = {
    id: state.editingId || makeId(),
    title: form.get("title").trim(),
    date: form.get("date") || todayKey(),
    start: form.get("start") || "09:00",
    durationMin: Number(form.get("durationMin") || 30),
    kind: form.get("kind") || "focus",
    note: form.get("note").trim(),
    status: (getEditingActivity() && getEditingActivity().status) || "planned"
  };
  if (state.editingId) {
    state.activities = state.activities.map((item) => item.id === state.editingId ? activity : item);
    state.lastMessage = "Activity updated.";
  } else {
    state.activities.push(activity);
    state.lastMessage = "Activity added.";
  }
  state.activeModal = null;
  state.editingId = null;
  persist();
  render();
}

function parseNoLlm(text) {
  const lines = text.split(/\n|;/).map((line) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
  return lines.map((line) => {
    const lower = line.toLowerCase();
    const duration = lower.match(/(\d+)\s?(m|min|minutes|h|hr|hours)/);
    const time = lower.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s?(am|pm)?\b/);
    const durationMin = duration ? Number(duration[1]) * (duration[2].startsWith("h") ? 60 : 1) : 30;
    const date = lower.includes("tomorrow") ? addDays(todayKey(), 1) : todayKey();
    return {
      id: makeId(),
      title: cleanTitle(line),
      date,
      start: time ? normalizeTime(time) : nextOpenTime(),
      durationMin,
      kind: inferKind(lower),
      note: "",
      status: "planned"
    };
  });
}

async function parseWithGemini(text, token) {
  const prompt = `Return only JSON array of activities. Each item must have title, date YYYY-MM-DD or empty, start HH:MM or empty, durationMin number, kind one of focus/admin/routine/personal. Text: ${text}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!response.ok) throw new Error("Gemini request failed");
  const data = await response.json();
  const raw = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
  const json = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(json).map((item) => ({
    id: makeId(),
    title: item.title || "Untitled",
    date: item.date || todayKey(),
    start: item.start || nextOpenTime(),
    durationMin: Number(item.durationMin || 30),
    kind: item.kind || "focus",
    note: "",
    status: "planned"
  }));
}

function saveFirebaseConfig() {
  const value = document.querySelector("[data-config='firebase']").value.trim();
  if (!value) {
    localStorage.removeItem(firebaseKey);
    firebaseRuntime = { ready: false, user: null };
    toast("Firebase config cleared.");
    render();
    return;
  }
  try {
    JSON.parse(value);
    localStorage.setItem(firebaseKey, value);
    toast("Firebase config saved.");
    boot();
  } catch {
    toast("Firebase config must be valid JSON.");
  }
}

function readFirebaseConfig() {
  try {
    const text = localStorage.getItem(firebaseKey);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function emptyActivity() {
  return {
    title: "",
    date: todayKey(),
    start: nextOpenTime(),
    durationMin: 30,
    kind: "focus",
    note: "",
    status: "planned"
  };
}

function getEditingActivity() {
  return state.activities.find((activity) => activity.id === state.editingId);
}

function updateActivity(id, changes) {
  state.activities = state.activities.map((activity) => activity.id === id ? { ...activity, ...changes } : activity);
}

function sortedActivities() {
  return [...state.activities].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

function groupByDate(items) {
  return items.reduce((groups, item) => {
    groups[item.date] = groups[item.date] || [];
    groups[item.date].push(item);
    return groups;
  }, {});
}

function weekKeys() {
  const today = new Date(`${todayKey()}T00:00:00`);
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return Array.from({ length: 7 }, (_, index) => addDays(todayKey(), mondayOffset + index));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(key, amount) {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + amount);
  return date.toISOString().slice(0, 10);
}

function nextOpenTime() {
  if (!state.activities.length) return "09:00";
  const last = sortedActivities()[state.activities.length - 1];
  return addMinutes(last.start, last.durationMin || 30);
}

function addMinutes(time, minutes) {
  const parts = time.split(":").map(Number);
  const total = parts[0] * 60 + parts[1] + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function normalizeTime(match) {
  let hour = Number(match[1]);
  const minute = match[2] || "00";
  const suffix = match[3];
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function inferKind(lower) {
  if (/walk|workout|sleep|call/.test(lower)) return "personal";
  if (/mail|send|admin|upload|print/.test(lower)) return "admin";
  if (/daily|every|routine/.test(lower)) return "routine";
  return "focus";
}

function cleanTitle(line) {
  return line
    .replace(/\b(today|tomorrow|tonight|daily|every day)\b/gi, "")
    .replace(/\b\d+\s?(m|min|minutes|h|hr|hours)\b/gi, "")
    .replace(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s?(am|pm)?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

function formatDay(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatDate(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(time) {
  const parts = time.split(":").map(Number);
  const suffix = parts[0] >= 12 ? "PM" : "AM";
  const hour = parts[0] % 12 || 12;
  return `${hour}:${String(parts[1]).padStart(2, "0")} ${suffix}`;
}

function titleCase(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function makeId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function toast(message) {
  const element = document.querySelector(".toast");
  if (!element) return;
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 2800);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
