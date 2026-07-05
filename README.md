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

## Firebase Spark setup

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

```bash
cp .firebaserc.example .firebaserc
# edit .firebaserc with your project id
firebase deploy --only firestore:rules,hosting
```

In this sandbox, use the project script instead of the global Firebase binary:

```bash
npm run deploy:firebase
```

If `.firebaserc` is not set yet, deploy with:

```bash
FIREBASE_PROJECT=your-project-id npm run deploy:firebase
```
