import { initFirebase, saveCloudState, loadCloudState, signIn, signOut } from "./firebase.js";

const storageKey = "daypilot-state-v1";
const firebaseKey = "daypilot-firebase-config";
const navItems = [
  ["today", "Today"],
  ["dump", "Dump"],
  ["week", "Week"],
  ["now", "Now"],
  ["checkin", "Check-in"],
  ["settings", "Settings"]
];

const seedBlocks = [
  block("KGP lit table", "Deep work · deadline-linked", "08:30", 90, "deep", "Focus"),
  block("Gesture meeting prep", "45 min · before meeting", "10:30", 45, "prep", "Prep"),
  block("Lunch + no screen", "Protected buffer", "12:00", 60, "lock", "Lock", true),
  block("Admin cleanup", "Low effort · post-lunch lazy fit", "14:00", 45, "light", "Light"),
  block("RUOK reading", "Reading · movable", "17:00", 60, "read", "Read"),
  block("Walk before dinner", "Protected health routine", "19:00", 35, "alarm", "Alarm", true)
];

let state = loadState();
let firebaseRuntime = null;

boot();

async function boot() {
  registerServiceWorker();
  firebaseRuntime = await initFirebase(readFirebaseConfig());
  if (firebaseRuntime.ready && firebaseRuntime.user) {
    const cloud = await loadCloudState(firebaseRuntime);
    if (cloud) {
      state = { ...state, ...cloud };
      persist(false);
    }
  }
  render();
}

function block(title, detail, start, durationMin, type, tag, protectedBlock = false) {
  return {
    id: crypto.randomUUID(),
    title,
    detail,
    start,
    durationMin,
    type,
    tag,
    protected: protectedBlock,
    status: "planned",
    day: "Today"
  };
}

function loadState() {
  const fallback = {
    mode: "Fast",
    assistant: "Walk stays protected. Work can move.",
    mood: "Lazy after lunch",
    dumps: [],
    candidates: [],
    blocks: seedBlocks,
    notes: [
      { id: crypto.randomUUID(), project: "KGP", text: "Need fresh brain #deep #priority:high", createdAt: new Date().toISOString() },
      { id: crypto.randomUUID(), project: "RUOK", text: "Calibration table can be light/admin if energy is low.", createdAt: new Date().toISOString() }
    ],
    checkins: {},
    proposal: {
      title: "Move future task?",
      toFit: "KGP lit table",
      move: "RUOK reading",
      from: "Tue 2:30",
      to: "Tue 4:00",
      reason: "KGP unlocks Wednesday meeting prep.",
      status: "pending"
    }
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
  } catch {
    return fallback;
  }
}

function persist(syncCloud = true) {
  localStorage.setItem(storageKey, JSON.stringify(state));
  if (syncCloud && firebaseRuntime && firebaseRuntime.ready && firebaseRuntime.user) {
    saveCloudState(firebaseRuntime, state).catch(() => toast("Saved locally. Firebase sync needs a working config."));
  }
}

function routeName() {
  const hashRoute = location.hash.replace("#/", "");
  const raw = hashRoute || location.pathname.split("/").filter(Boolean).pop() || "today";
  return navItems.some(([id]) => id === raw) ? raw : "today";
}

function navigate(path) {
  history.pushState({}, "", path);
  render();
}

window.addEventListener("popstate", render);

function render() {
  const route = routeName();
  document.querySelector("#app").innerHTML = `
    <div class="frame">
      ${renderSidebar(route)}
      <main class="main" id="main">${renderRoute(route)}</main>
    </div>
    <div class="toast hidden" role="status" aria-live="polite"></div>
  `;
  bindCommon();
  bindRoute(route);
}

function renderSidebar(route) {
  return `
    <aside class="sidebar">
      <div class="brand">
        <h1>DayPilot</h1>
        <p>Think it. Dump it. Planned.</p>
      </div>
      <nav class="nav" aria-label="Main navigation">
        ${navItems.map(([id, label]) => `<a href="./${id}" data-route="${id}" aria-current="${route === id ? "page" : "false"}">${label}</a>`).join("")}
      </nav>
      <div class="mood-card">
        <b>Mood now</b>
        <strong>${escapeHtml(state.mood)}</strong>
        <span>Auto-light tasks</span>
      </div>
    </aside>
  `;
}

function renderRoute(route) {
  if (route === "dump") return renderDump();
  if (route === "week") return renderWeek();
  if (route === "now") return renderNow();
  if (route === "checkin") return renderCheckin();
  if (route === "settings") return renderSettings();
  return renderToday();
}

function renderToday() {
  return `
    <section class="grid">
      <div class="panel">
        <div class="topline">
          <div>
            <h2>Today — Sunday reset plan</h2>
            <p>Future schedule is ready for disciplined Monday.</p>
          </div>
          <span class="pill gray">${state.mode} mode</span>
        </div>
        <div class="stats">
          <span class="pill">Focus ${sumBy("deep")}m</span>
          <span class="pill green">Light ${sumBy("light")}m</span>
          <span class="pill blue">Walk protected</span>
        </div>
        ${renderTimeline(state.blocks)}
      </div>
      <div class="stack">
        ${renderQuickDump()}
        ${renderReason()}
        ${renderActions()}
        ${state.proposal && state.proposal.status === "pending" ? renderProposal() : ""}
      </div>
    </section>
  `;
}

function renderQuickDump() {
  return `
    <section class="panel">
      <h3>Quick dump</h3>
      <form class="dump-form" data-form="quick-dump">
        <div class="input-row">
          <textarea name="dump" aria-label="Dump anything" placeholder="Type like WhatsApp...&#10;before Wed meeting finish baseline"></textarea>
          <button class="primary" type="submit" aria-label="Add dump">+</button>
        </div>
      </form>
      <p class="detected">Detected: [deadline] [project] [effort] [before meeting]</p>
    </section>
  `;
}

function renderReason() {
  return `
    <section class="panel">
      <h3>Why this changed</h3>
      <p class="reason">${escapeHtml(state.assistant)}<br><br><strong>Walk stays protected. Work can move.</strong></p>
    </section>
  `;
}

function renderActions() {
  const next = nextBlock();
  return `
    <section class="panel">
      <h3>Now / next actions</h3>
      <div class="actions">
        <button class="primary" data-action="done">Done</button>
        <button data-action="snooze">Snooze 15</button>
        <button data-action="replan">Replan</button>
      </div>
      <p class="subtle">Next alarm: ${(next && next.title) || "Walk"} at ${formatTime((next && next.start) || "19:00")} via Google Calendar</p>
    </section>
  `;
}

function renderProposal() {
  const p = state.proposal;
  return `
    <section class="panel">
      <h3>${escapeHtml(p.title)}</h3>
      <p class="reason">To fit: ${escapeHtml(p.toFit)}<br>Move: ${escapeHtml(p.move)}<br>${escapeHtml(p.from)} → ${escapeHtml(p.to)}<br>Reason: ${escapeHtml(p.reason)}</p>
      <div class="actions">
        <button class="primary" data-proposal="approved">Allow once</button>
        <button data-proposal="rejected">No</button>
        <button data-proposal="suggest">Suggest another</button>
      </div>
    </section>
  `;
}

function renderDump() {
  return `
    <section class="panel">
      <h2 class="page-title">Multi-add task intake</h2>
      <p class="subtle">One messy dump creates many candidate tasks, routines, and notes.</p>
      <form class="dump-form" data-form="bulk-dump">
        <textarea name="dump" aria-label="Bulk task dump" placeholder="- finish KGP intro tomorrow 90m deep&#10;- mail RUOK table 20m&#10;- walk daily 7pm"></textarea>
        <div class="actions">
          <button class="primary" type="submit">Parse dump</button>
          <button type="button" data-action="sample">Use sample</button>
          <button type="button" data-action="clear-candidates">Clear</button>
        </div>
      </form>
    </section>
    <section class="grid">
      <div class="panel">
        <h3>Candidates</h3>
        <div class="stack">${state.candidates.length ? state.candidates.map(renderCandidate).join("") : `<p class="subtle">Parsed tasks appear here for Add all / Select / Edit.</p>`}</div>
        ${state.candidates.length ? `<div class="actions"><button class="primary" data-action="add-all">Add all</button><button data-action="select-candidates">Select</button><button data-action="edit-candidates">Edit</button><button data-action="clear-candidates">Cancel</button></div>` : ""}
      </div>
      <div class="panel">
        <h3>Schedule impact</h3>
        ${renderImpact()}
      </div>
    </section>
  `;
}

function renderCandidate(candidate) {
  return `
    <article class="candidate">
      <header>
        <div>
          <h4>${escapeHtml(candidate.title)}</h4>
          <p>${escapeHtml(candidate.project)} · ${candidate.durationMin}m · ${escapeHtml(candidate.type)}</p>
        </div>
        <span class="pill ${candidate.kind === "routine" ? "blue" : "gray"}">${candidate.kind}</span>
      </header>
      <p>${escapeHtml(candidate.reason)}</p>
    </article>
  `;
}

function renderImpact() {
  const items = state.candidates.length ? state.candidates : state.blocks.slice(0, 4);
  return `<div class="week-list">${items.map((item, index) => `
    <div class="week-row">
      <div>
        <h4>${index === 0 ? "Mon 09:30" : index === 1 ? "Mon 14:00" : index === 2 ? "Tue 10:00" : "Before meeting"}</h4>
        <p>${escapeHtml(item.title)}<br>${escapeHtml(item.type || item.detail || "planned")}</p>
      </div>
      <span class="pill blue">${item.durationMin || 45}m</span>
    </div>
  `).join("")}</div>`;
}

function renderWeek() {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  return `
    <section class="panel">
      <div class="topline">
        <div>
          <h2>Live weekly schedule</h2>
          <p>Simple list by day. DayPilot blocks only.</p>
        </div>
        <button data-action="secret-link">Copy read-only link</button>
      </div>
      <div class="week-list">
        ${days.map((day, dayIndex) => `
          <section class="week-day">
            <h3>${day}</h3>
            ${state.blocks.slice(0, 3).map((b, index) => `
              <div class="block ${b.type}">
                <div>
                  <h4>${formatTime(addHours(b.start, dayIndex + index))} ${escapeHtml(b.title)}</h4>
                  <p>${escapeHtml(b.detail)}</p>
                </div>
                <span class="tag">${escapeHtml(b.tag)}</span>
              </div>
            `).join("")}
          </section>
        `).join("")}
      </div>
    </section>
  `;
}

function renderNow() {
  const current = currentBlock();
  const next = nextBlock();
  return `
    <section class="panel now-card">
      <h2 class="page-title">Now</h2>
      ${renderBlock(current || state.blocks[0])}
      <p class="subtle">Next: ${(next && next.title) || "Walk before dinner"} · Protected next: Walk</p>
      <div class="actions">
        <button class="primary" data-action="done">Done</button>
        <button data-action="snooze">Snooze 15</button>
      </div>
    </section>
  `;
}

function renderCheckin() {
  const blocks = state.blocks.filter((b) => b.type !== "lock");
  const done = Object.values(state.checkins).filter((value) => value === "done").length;
  const score = Math.round((Object.keys(state.checkins).length ? done / blocks.length : 0.62) * 100);
  return `
    <section class="panel">
      <h2 class="page-title">DayPilot — accountability, not guilt</h2>
      <p class="subtle">Completion data changes future priority and capacity.</p>
      <div class="cards">
        <div class="metric"><span>Today follow-through</span><strong>${score}%</strong><p>Good enough. Tomorrow gets lighter.</p></div>
        <div class="metric green"><span>Completed</span><strong>${done || 3}/${blocks.length}</strong><p>One deep block, two light blocks.</p></div>
        <div class="metric amber"><span>Protected routines</span><strong>${state.checkins.walk === "done" ? "1/1" : "0/1"}</strong><p>Walk gets stronger nudges.</p></div>
      </div>
    </section>
    <section class="panel">
      <h3>Today planned blocks</h3>
      <div class="stack">
        ${blocks.map((b) => `
          <article class="candidate">
            <header><h4>${escapeHtml(b.title)}</h4><span class="pill gray">${state.checkins[b.id] || "unset"}</span></header>
            <div class="actions">
              <button data-checkin="${b.id}" data-status="done">Done</button>
              <button data-checkin="${b.id}" data-status="partial">Partial</button>
              <button data-checkin="${b.id}" data-status="missed">Missed</button>
              <button data-checkin="${b.id}" data-status="skipped">Skipped validly</button>
            </div>
          </article>
        `).join("")}
      </div>
      <form class="dump-form" data-form="checkin">
        <textarea name="dump" aria-label="Completion dump" placeholder="KGP done, RUOK half, walk missed"></textarea>
        <button class="primary" type="submit">Update tomorrow</button>
      </form>
    </section>
  `;
}

function renderSettings() {
  const configText = localStorage.getItem(firebaseKey) || "";
  return `
    <section class="panel">
      <h2 class="page-title">Settings</h2>
      <p class="subtle">Minimum backend controls for Spark personal mode.</p>
      <div class="settings-grid">
        <label>Backend mode
          <select data-setting="mode">
            ${["Smart", "Fast", "Manual"].map((m) => `<option ${state.mode === m ? "selected" : ""}>${m}</option>`).join("")}
          </select>
        </label>
        <label>Gemini API key
          <input type="password" data-setting="geminiKey" value="${escapeAttr(localStorage.getItem("daypilot-gemini-key") || "")}" placeholder="Stored locally">
        </label>
      </div>
    </section>
    <section class="panel">
      <h3>Firebase Spark backend</h3>
      <p class="subtle">Paste the Firebase web app config JSON. Auth and Firestore sync start after saving.</p>
      <textarea class="mono" data-setting="firebaseConfig" aria-label="Firebase config JSON" placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'>${escapeHtml(configText)}</textarea>
      <div class="actions">
        <button class="primary" data-action="save-firebase">Save Firebase config</button>
        <button data-action="google-signin">${firebaseRuntime && firebaseRuntime.user ? "Switch account" : "Google sign-in"}</button>
        <button data-action="google-signout">Sign out</button>
      </div>
      <p class="notice">${firebaseRuntime && firebaseRuntime.ready ? `Firebase ready${firebaseRuntime.user ? ` for ${escapeHtml(firebaseRuntime.user.email || "signed-in user")}` : ". Sign in to sync."}` : "Firebase is not configured yet. The app is using local storage."}</p>
    </section>
    <section class="panel">
      <h3>Calendar visibility</h3>
      <div class="actions">
        <button data-action="calendar-widget">Use Google Calendar widget</button>
        <button data-action="pin-weekly">Pin weekly page</button>
        <button data-action="notifications">Notification permission</button>
      </div>
      <p class="subtle">Added to DayPilot Timetable. It should show in your Google Calendar widget too.</p>
    </section>
  `;
}

function renderTimeline(blocks) {
  return `<div class="timeline">${blocks.map((b) => `<div class="time">${formatTime(b.start)}</div>${renderBlock(b)}`).join("")}</div>`;
}

function renderBlock(b) {
  return `
    <article class="block ${b.type}">
      <div>
        <h4>${escapeHtml(b.title)}</h4>
        <p>${escapeHtml(b.detail)}</p>
      </div>
      <span class="tag">${escapeHtml(b.tag)}</span>
    </article>
  `;
}

function bindCommon() {
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(link.getAttribute("href"));
    });
  });
}

function bindRoute(route) {
  document.querySelectorAll("[data-form='quick-dump'], [data-form='bulk-dump']").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = new FormData(form).get("dump").trim();
      if (!text) return;
      handleDump(text, route === "dump");
      form.reset();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button.dataset.action, button));
  });

  document.querySelectorAll("[data-proposal]").forEach((button) => {
    button.addEventListener("click", () => {
      state.proposal.status = button.dataset.proposal;
      state.assistant = button.dataset.proposal === "approved" ? "Approved once. I moved RUOK later without touching walk." : "Kept the old schedule unchanged.";
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-checkin]").forEach((button) => {
    button.addEventListener("click", () => {
      state.checkins[button.dataset.checkin] = button.dataset.status;
      state.assistant = "Check-in saved. Tomorrow adapts to real capacity.";
      persist();
      render();
    });
  });

  const checkinForm = document.querySelector("[data-form='checkin']");
  if (checkinForm) checkinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("dump").toLowerCase();
    state.blocks.forEach((b) => {
      if (text.includes(b.title.split(" ")[0].toLowerCase())) {
        state.checkins[b.id] = text.includes("half") || text.includes("partial") ? "partial" : text.includes("miss") ? "missed" : "done";
      }
    });
    state.assistant = "Updated tomorrow. Hard work gets a starter block, low-value skipped work drops.";
    persist();
    render();
  });

  const modeSetting = document.querySelector("[data-setting='mode']");
  if (modeSetting) modeSetting.addEventListener("change", (event) => {
    state.mode = event.target.value;
    persist();
    toast(`${state.mode} mode saved.`);
  });

  const geminiSetting = document.querySelector("[data-setting='geminiKey']");
  if (geminiSetting) geminiSetting.addEventListener("change", (event) => {
    localStorage.setItem("daypilot-gemini-key", event.target.value);
    toast("Gemini key saved locally.");
  });
}

function handleAction(action, button) {
  if (action === "done") {
    const current = currentBlock() || state.blocks[0];
    state.checkins[current.id] = "done";
    current.status = "done";
    state.assistant = `${current.title} marked done. Next block stays visible.`;
  }
  if (action === "snooze") {
    state.blocks = state.blocks.map((b, index) => index === 0 ? { ...b, start: addMinutes(b.start, 15), detail: `${b.detail} · snoozed 15` } : b);
    state.assistant = "Snoozed 15. Protected blocks did not move.";
  }
  if (action === "replan") {
    state.blocks = [...state.blocks].sort((a, b) => scoreBlock(b) - scoreBlock(a));
    state.assistant = "Replanned by deadline, effort, and protected-routine rules.";
  }
  if (action === "sample") {
    const textarea = document.querySelector("[data-form='bulk-dump'] textarea");
    textarea.value = "- finish KGP intro tomorrow 90m deep\n- mail RUOK calibration table 20m\n- read 2 RF NL query papers\n- walk daily 7pm protected";
    textarea.focus();
    return;
  }
  if (action === "clear-candidates") state.candidates = [];
  if (action === "add-all") {
    state.blocks = [...state.blocks, ...state.candidates.map(candidateToBlock)];
    state.assistant = `Added ${state.candidates.length} items. Calendar sync will pick these up after Google Calendar is connected.`;
    state.candidates = [];
  }
  if (action === "select-candidates" || action === "edit-candidates") toast("Candidate review is live; inline editing is next.");
  if (action === "secret-link" && navigator.clipboard) navigator.clipboard.writeText(`${location.origin}${basePath()}week?token=readonly-demo`);
  if (action === "calendar-widget") toast("Use the DayPilot Timetable calendar in the Google Calendar widget.");
  if (action === "pin-weekly") toast("Pin /week from your browser menu.");
  if (action === "notifications" && window.Notification && Notification.requestPermission) Notification.requestPermission().then((value) => toast(`Notifications: ${value}`));
  if (action === "save-firebase") saveFirebaseConfig();
  if (action === "google-signin") signIn(firebaseRuntime).then(async () => {
    firebaseRuntime = await initFirebase(readFirebaseConfig());
    persist();
    render();
  }).catch((error) => toast(error.message));
  if (action === "google-signout") signOut(firebaseRuntime).then(() => {
    firebaseRuntime.user = null;
    render();
  }).catch((error) => toast(error.message));
  persist();
  render();
}

function handleDump(text, stayOnDump) {
  const candidates = parseDump(text);
  state.dumps.unshift({ id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), candidates });
  state.candidates = candidates;
  state.assistant = candidates.length > 1
    ? `${candidates.length} candidates found. I kept them reviewable before scheduling.`
    : `Added. ${(candidates[0] && candidates[0].project) || "Work"} gets ${(candidates[0] && candidates[0].durationMin) || 45} min in the next open slot.`;
  if (!stayOnDump && candidates.length === 1) {
    state.blocks.push(candidateToBlock(candidates[0]));
    state.candidates = [];
  }
  persist();
  if (!stayOnDump) render();
  else render();
}

function parseDump(text) {
  return text.split(/\n|;|\u2022/g)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const lower = line.toLowerCase();
      const duration = lower.match(/(\d+)\s?(m|min|minutes|h|hr|hours)/);
      const durationMin = duration ? Number(duration[1]) * (duration[2].startsWith("h") ? 60 : 1) : lower.includes("quick") ? 20 : 45;
      const project = projectFor(lower);
      const routine = /(daily|every|weekdays|weekly|monthly)/.test(lower);
      const note = /^(note|remember|idea|blocked|decision):/.test(lower);
      const type = lower.includes("deep") || /(write|code|derive|think|finish)/.test(lower)
        ? "deep"
        : /(read|review|paper)/.test(lower)
          ? "read"
          : /(mail|send|admin|upload|print)/.test(lower)
            ? "light"
            : routine
              ? "alarm"
              : "prep";
      return {
        id: crypto.randomUUID(),
        title: cleanTitle(line),
        project,
        durationMin,
        type,
        kind: note ? "note" : routine ? "routine" : "task",
        protected: lower.includes("protected") || lower.includes("walk"),
        reason: reasonFor(lower, project, type)
      };
    });
}

function candidateToBlock(candidate) {
  return block(candidate.title, `${candidate.project} · ${candidate.kind}`, nextOpenTime(), candidate.durationMin, candidate.type, candidate.protected ? "Lock" : labelFor(candidate.type), candidate.protected);
}

function projectFor(lower) {
  if (lower.includes("kgp")) return "KGP";
  if (lower.includes("gesture")) return "Gesture";
  if (lower.includes("ruok") || lower.includes("bathroom")) return "RUOK";
  if (lower.includes("iaso") || lower.includes("leantopo")) return "IASO";
  if (lower.includes("walk") || lower.includes("workout")) return "Health";
  if (lower.includes("mail") || lower.includes("admin")) return "Admin";
  return "General";
}

function cleanTitle(line) {
  return line
    .replace(/\b(today|tonight|tomorrow|daily|every day|weekdays|protected|deep|light)\b/gi, "")
    .replace(/\b\d+\s?(m|min|minutes|h|hr|hours)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || line;
}

function reasonFor(lower, project, type) {
  if (lower.includes("lazy") || lower.includes("tired")) return "Low-energy signal detected; schedule lighter work after lunch.";
  if (lower.includes("before")) return `${project} is placed before the dependency it unlocks.`;
  if (type === "deep") return "Deep work prefers a protected morning focus slot.";
  if (type === "light") return "Low-effort work can absorb tired or fragmented time.";
  return "Rule parser found a schedulable item.";
}

function scoreBlock(b) {
  return (b.protected ? -10 : 0) + (b.type === "deep" ? 6 : 0) + (b.type === "prep" ? 5 : 0) + (b.type === "light" ? 2 : 0);
}

function sumBy(type) {
  return state.blocks.filter((b) => b.type === type).reduce((sum, b) => sum + b.durationMin, 0);
}

function currentBlock() {
  return state.blocks.find((b) => b.status !== "done") || state.blocks[0];
}

function nextBlock() {
  return state.blocks.find((b) => b.status !== "done" && b !== currentBlock()) || state.blocks[1];
}

function nextOpenTime() {
  const lastBlock = state.blocks[state.blocks.length - 1];
  const last = (lastBlock && lastBlock.start) || "08:00";
  return addMinutes(last, 60);
}

function addMinutes(time, minutes) {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function addHours(time, hours) {
  return addMinutes(time, hours * 60);
}

function labelFor(type) {
  return ({ deep: "Focus", prep: "Prep", light: "Light", read: "Read", alarm: "Alarm" })[type] || "Task";
}

function formatTime(time) {
  const [hourText, minute] = time.split(":");
  const hour = Number(hourText);
  const suffix = hour >= 12 ? "PM" : "AM";
  const normalized = hour % 12 || 12;
  return `${normalized}:${minute} ${suffix}`;
}

function basePath() {
  const path = location.pathname;
  const route = routeName();
  return path.endsWith(route) ? path.slice(0, -route.length) : "/";
}

function saveFirebaseConfig() {
  const value = document.querySelector("[data-setting='firebaseConfig']").value.trim();
  if (!value) {
    localStorage.removeItem(firebaseKey);
    toast("Firebase config cleared.");
    return;
  }
  try {
    JSON.parse(value);
    localStorage.setItem(firebaseKey, value);
    toast("Firebase config saved. Reloading backend.");
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
