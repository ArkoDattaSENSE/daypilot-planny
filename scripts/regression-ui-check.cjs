const WebSocket = require("ws");

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: node scripts/regression-ui-check.cjs ws://127.0.0.1:9222/devtools/page/<id>");
  process.exit(1);
}

let id = 0;
const ws = new WebSocket(endpoint);

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const onMessage = (message) => {
      const data = JSON.parse(message);
      if (data.id !== requestId) return;
      ws.off("message", onMessage);
      data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(expression) {
  return send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
}

async function submitChat(text) {
  await evaluate("document.querySelector('[data-open-modal=\"chat\"]').click()");
  await wait(200);
  await evaluate(`
    const input = document.querySelector('[data-chat-input]');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="submit-chat"]').click();
  `);
  await wait(600);
}

ws.on("open", async () => {
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await evaluate("localStorage.clear()");
    await send("Page.navigate", { url: "http://localhost:8000/" });
    await wait(1000);
    await submitChat("On wednesdays I have meeting xxx 9am 30m");
    const parsed = await evaluate(`
      JSON.stringify(JSON.parse(localStorage.getItem('daypilot-state-v2')).activities.map((a) => ({
        title: a.title,
        date: a.date,
        start: a.start,
        recurrence: a.recurrence,
        locked: a.locked
      })))
    `);
    const activities = JSON.parse(parsed.result.value);
    const activity = activities[0];
    if (!activity) throw new Error("No activity created");
    if (activity.recurrence.byDay !== "WE") throw new Error(`Expected WE recurrence, got ${JSON.stringify(activity.recurrence)}`);
    if (new Date(`${activity.date}T00:00:00`).getDay() !== 3) throw new Error(`Expected Wednesday date, got ${activity.date}`);
    if (activity.locked !== true) throw new Error("Expected meeting to be fixed/locked");

    await evaluate(`
      localStorage.setItem('daypilot-state-v2', JSON.stringify({
        view: 'day',
        route: 'home',
        mood: { label: 'Okay', energy: 55, stress: 35 },
        settings: { parserMode: 'manual', workDone: 0, exhaustion: 20, checkinEnabled: false, checkinTime: '21:00', checkinText: '' },
        profile: { workStart: '', workEnd: '', peakStart: '', peakEnd: '', maxFocusMin: 90, breakMin: 15, drainingTasks: '', energizingTasks: '' },
        selectedProject: 'Inbox',
        activities: [
          { id: 'locked-meeting', title: 'Meeting xxx', project: 'Inbox', branch: 'Main', date: '2026-07-08', start: '10:00', durationMin: 60, kind: 'routine', recurrence: null, note: '', status: 'planned', locked: true, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
          { id: 'write-intro', title: 'Write intro', project: 'Inbox', branch: 'Main', date: '2026-07-08', start: '13:00', durationMin: 60, kind: 'focus', recurrence: null, note: '', status: 'planned', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
          { id: 'email-update', title: 'Email update', project: 'Inbox', branch: 'Main', date: '2026-07-08', start: '11:00', durationMin: 30, kind: 'admin', recurrence: null, note: '', status: 'planned', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' }
        ],
        projectNotes: [],
        branches: [],
        checkins: {},
        calendar: { calendarId: '', lastSync: '' },
        calendarTombstones: [],
        chatDraft: '',
        activeModal: null,
        editingId: null,
        pendingParse: null,
        chatClarify: null,
        questionnaireReturn: null,
        pendingRecurringEdit: null,
        lastMessage: 'Regression state ready.'
      }));
    `);
    await send("Page.reload", { ignoreCache: true });
    await wait(700);
    await submitChat("move write intro to 10am");
    const rescheduled = await evaluate(`
      JSON.stringify(JSON.parse(localStorage.getItem('daypilot-state-v2')).activities.map((a) => ({
        id: a.id,
        title: a.title,
        date: a.date,
        start: a.start,
        locked: a.locked
      })).sort((a, b) => a.id.localeCompare(b.id)))
    `);
    const moved = JSON.parse(rescheduled.result.value);
    const byId = Object.fromEntries(moved.map((item) => [item.id, item]));
    if (byId["locked-meeting"].start !== "10:00") throw new Error("Fixed meeting moved during reschedule");
    if (byId["write-intro"].start !== "11:00") throw new Error(`Flexible target did not move after fixed meeting: ${byId["write-intro"].start}`);
    if (byId["email-update"].start !== "12:00") throw new Error(`Flexible neighbor did not shift after target: ${byId["email-update"].start}`);
    console.log(JSON.stringify({ parsed: activity, rescheduled: moved }));
    ws.close();
  } catch (error) {
    console.error(error);
    ws.close();
    process.exitCode = 1;
  }
});
