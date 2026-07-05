const sdkVersion = "10.12.5";

export async function initFirebase(config) {
  const runtime = { ready: false, app: null, auth: null, db: null, user: null };
  if (!config || !config.apiKey || !config.projectId || !config.appId) return runtime;

  try {
    const [{ initializeApp }, { getAuth, GoogleAuthProvider, onAuthStateChanged }, { getFirestore }] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-firestore.js`)
    ]);
    runtime.app = initializeApp(config);
    runtime.auth = getAuth(runtime.app);
    runtime.provider = new GoogleAuthProvider();
    runtime.db = getFirestore(runtime.app);
    runtime.ready = true;
    runtime.GoogleAuthProvider = GoogleAuthProvider;
    await new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(runtime.auth, (user) => {
        runtime.user = user;
        unsubscribe();
        resolve();
      });
    });
  } catch (error) {
    console.warn("Firebase init failed", error);
  }

  return runtime;
}

export async function signIn(runtime) {
  assertRuntime(runtime);
  const { signInWithPopup } = await import(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-auth.js`);
  const result = await signInWithPopup(runtime.auth, runtime.provider);
  runtime.user = result.user;
  return result.user;
}

export async function signOut(runtime) {
  assertRuntime(runtime);
  const auth = await import(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-auth.js`);
  return auth.signOut(runtime.auth);
}

export async function loadCloudState(runtime) {
  assertRuntime(runtime);
  if (!runtime.user) return null;
  const { doc, getDoc } = await import(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-firestore.js`);
  const snapshot = await getDoc(doc(runtime.db, "users", runtime.user.uid, "appState", "current"));
  return snapshot.exists() ? snapshot.data().state : null;
}

export async function saveCloudState(runtime, state) {
  assertRuntime(runtime);
  if (!runtime.user) return;
  const { doc, setDoc, serverTimestamp } = await import(`https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-firestore.js`);
  await setDoc(doc(runtime.db, "users", runtime.user.uid, "appState", "current"), {
    state: sanitizeState(state),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

function sanitizeState(state) {
  return JSON.parse(JSON.stringify({
    mode: state.mode,
    assistant: state.assistant,
    mood: state.mood,
    dumps: state.dumps,
    candidates: state.candidates,
    blocks: state.blocks,
    notes: state.notes,
    checkins: state.checkins,
    proposal: state.proposal
  }));
}

function assertRuntime(runtime) {
  if (!runtime || !runtime.ready) {
    throw new Error("Firebase is not configured yet.");
  }
}
