# Gatekeeper – gate entry / exit app

Gatekeeper for daily IN/OUT movement of **people and material** across multiple units.

## How it works

1. **Guard at the gate** (each unit has its own guard logins) taps **+ New Entry** and picks *Person* or *Material*. They fill in name, mobile, company, purpose, whom to meet, vehicle no. and material/qty/challan, can take a photo, and tap **Send for approval**.
2. **Admin** gets a notification right away: a popup with a sound in the app, plus a phone push notification if the app is closed. The popup has a big **green ✔ Approve** and a **red ✖ Reject** button and an optional remark.
3. **Guard** gets the answer as a full-screen **green APPROVED – allow entry** or **red REJECTED – do not allow** alert, plus a push notification.
4. When the person or material leaves, the guard opens **Inside** and taps **🚪 Mark OUT**. The app stores IN time, OUT time and **time spent inside**.
5. **Reports**: filter by unit, date, type, status or search text, then download the register as **Excel/CSV** (includes minutes inside).

### Roles
| Login | Can do |
|---|---|
| Main admin (unit = *All units*) | Sees and approves every unit; creates units and logins; reports for all units |
| Unit admin (admin + one unit) | Sees and approves only that unit |
| Guard (always one unit) | Raises requests for their unit only; marks OUT; sees only their unit |

## Run it

Needs **Node.js 22.5 or newer** (it uses Node's built-in SQLite; there is no separate database to install).

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. First-run logins:

- `admin` / `admin123` – main admin
- `guard1` / `guard123` – guard of "Unit 1"

**Change these passwords right away** (Account tab). Then add your units and guard logins from the **Units** and **Users** tabs.

Data is stored in `data/gatekeeper.db`. Back up this file. You can change the folder with `DATA_DIR=/path` and the port with `PORT=8080`.

## Phones & notifications

- Open the site on the phone and choose **Add to Home Screen** / **Install app**. It then runs like an app.
- Tap **Enable** on the notification banner on each guard and admin phone.
- Push notifications when the app is closed need the site to be served over **HTTPS** (for example behind Nginx/Caddy with a domain, or a hosting service such as Render or Railway). On a local network without HTTPS, alerts still work while the app is open.
- On iPhone, push works only after the app is added to the Home Screen (iOS 16.4+).
- Optional: set `VAPID_SUBJECT=mailto:you@yourcompany.com` for the push service contact.

## Android app (full-screen alerts like an incoming call)

The `android/` folder has an Android app that opens the same Gatekeeper site. When a request arrives, it also shows a **full-screen alert in front of everything, even on the lock screen**:
- **Admin:** visitor details with big green **APPROVE** and red **REJECT** buttons, ringing until someone handles it.
- **Guard:** a full green **APPROVED** or red **REJECTED** screen.

The web app and the Android app work together with the same logins and data.

### One-time setup
1. **Firebase (free):**
   1. At https://console.firebase.google.com create a project.
   2. Add an **Android app** with package name `com.wellworth.gatekeeper`, then download **google-services.json**.
   3. Open **Project settings → Service accounts → Generate new private key**. This downloads a JSON file.
2. **Render:** open your service, then **Environment → Secret Files**, and add two files:
   - filename `google-services.json` → paste that file's contents
   - filename `firebase-service-account.json` → paste the private key file's contents

   Save; Render redeploys. The log should then show `Android app alerts (Firebase): ON`.
3. **GitHub (signing key):** in the repo, open **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `ANDROID_KEYSTORE_B64`
   - Value: the signing key text you were given.

   This lets phones install updates without uninstalling first.
4. **Build:** every push that changes `android/` builds the app automatically (**Actions** tab).

   Download link for phones: `https://<your-server>/app`, or https://github.com/abrai2134/gatekeeperapp/releases/latest/download/gatekeeper.apk

### On each Android phone
1. Open the download link, install `gatekeeper.apk`, and allow **Install unknown apps** when asked.
2. Open **Gatekeeper**, log in, and allow notifications.
3. Go to **Account → Full-screen alerts on this phone** and tap **Fix** on every ❌ until all are ✅:
   - Full-screen alerts
   - Display over other apps
   - Battery not optimised
4. Tap **Send test alert** and lock the phone. A full-screen alert should appear within about 5 seconds.

## Test

```bash
npm test
```

This runs an end-to-end check: request → admin live alert → approve/reject → guard live alert → mark OUT → duration, plus unit isolation and permissions.
