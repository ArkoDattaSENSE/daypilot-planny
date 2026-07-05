# DayPilot / Planny

A static, chat-first scheduling PWA built from the supplied DayPilot design bundle.

## What is included

- Mobile-first Today, Dump, Week, Now, Check-in, and Settings routes.
- Rule-based no-LLM parser for multi-task dumps.
- Lazy-mode actions: Done, Snooze, Replan.
- Permission-gate card for future task moves.
- Accountability check-in flow.
- Firebase Spark-ready backend: Google Auth plus per-user Firestore state.
- GitHub Pages workflow that publishes only the clean `dist/` artifact.

## Local

```bash
npm test
npm run build
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

## Setting Firebase Up

Your current Firebase project is:

```text
labtrack-559e9
```

Codex has set this in `.firebaserc`, so the normal deploy command is:

```bash
npm run deploy:firebase
```

That command builds the clean static artifact into `dist/` and deploys only that folder plus Firestore rules.

The Firebase Web App config for `labtrack` is already wired into `src/firebase-config.js`, so the deployed app can use Firebase Auth and Firestore without pasting JSON into Settings. Settings still lets you override the config locally if needed.

To find a Firebase project ID later:

```bash
FIREBASE_CLI_DISABLE_UPDATE_CHECK=true ./node_modules/.bin/firebase projects:list
```

The project ID is the value in the `Project ID` column, not the display name or project number.

For a new project, keep it on the free Spark plan and then enable:

1. Create a Firebase project on the Spark plan.
2. Enable Authentication, then enable the Google provider.
3. Enable Cloud Firestore.
4. Deploy `firestore.rules`.
5. In the app, open Settings and paste the Firebase web app config JSON.

The app stores data at:

```text
/users/{uid}/appState/current
```

The included rule only lets the signed-in user read and write their own path.

## GitHub Pages deploy

This workspace has a read-only `.git` placeholder, so Codex initialized the usable git repository at `.planny_git`.

```bash
git --git-dir=.planny_git --work-tree=. branch -M main
git --git-dir=.planny_git --work-tree=. add .
git --git-dir=.planny_git --work-tree=. commit -m "Build DayPilot static PWA"
gh repo create daypilot-planny --public --description "DayPilot static PWA" --remote origin
git --git-dir=.planny_git --work-tree=. push -u origin main
```

Then enable Pages in the repo settings with GitHub Actions as the source. The included workflow deploys on push.

## Firebase Hosting deploy

Firebase Hosting is optional because the frontend is designed for GitHub Pages, but the config is included:

Use the project script instead of the global Firebase binary:

```bash
npm run deploy:firebase
```

If you want to override `.firebaserc` for one deploy:

```bash
FIREBASE_PROJECT=your-project-id npm run deploy:firebase
```
