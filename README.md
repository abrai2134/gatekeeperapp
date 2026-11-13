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

## Test

```bash
npm test
```

This runs an end-to-end check: request → admin live alert → approve/reject → guard live alert → mark OUT → duration, plus unit isolation and permissions.
