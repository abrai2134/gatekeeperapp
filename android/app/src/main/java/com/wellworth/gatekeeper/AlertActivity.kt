package com.wellworth.gatekeeper

import android.app.Activity
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * The big screen that pops up in front of everything (also on the lock screen):
 *  - admin: visitor details with large green APPROVE / red REJECT buttons
 *  - guard: full green APPROVED or red REJECTED screen
 */
class AlertActivity : Activity() {

    companion object {
        @Volatile private var current: AlertActivity? = null

        fun closeIfShowing(entryId: Int, by: String?) {
            val a = current ?: return
            a.runOnUiThread {
                if (a.entryId == entryId && !a.isFinishing && !a.busy) {
                    a.stopRing()
                    Toast.makeText(a, if (by != null) "Already handled by $by" else "Already handled", Toast.LENGTH_LONG).show()
                    a.finish()
                }
            }
        }
    }

    private var entryId = 0
    private var busy = false
    private var ringtone: Ringtone? = null
    private val handler = Handler(Looper.getMainLooper())
    private val d get() = resources.displayMetrics.density
    private fun dp(v: Int) = (v * d).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Prefs.init(this)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        current = this
        show(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        show(intent)
    }

    override fun onDestroy() {
        stopRing()
        if (current === this) current = null
        super.onDestroy()
    }

    // touching the screen stops the ringing (the alert stays until a button is pressed)
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_DOWN) stopRing()
        return super.dispatchTouchEvent(ev)
    }

    private fun show(i: Intent) {
        val kind = i.getStringExtra("kind") ?: "test"
        entryId = i.getIntExtra("notifId", 0)
        val entry = try { JSONObject(i.getStringExtra("entry") ?: "{}") } catch (e: Exception) { JSONObject() }
        // the notification sound is replaced by our own ringing while this screen is visible
        Alerts.cancel(this, entryId)
        when (kind) {
            "request" -> { showRequest(entry, i); startRing() }
            "approved", "rejected" -> showResult(kind == "approved", entry, i)
            else -> showSimple("✔ Full-screen alerts are working", i.getStringExtra("body") ?: "", Color.parseColor("#2563EB"))
        }
    }

    // ---------------------------------------------------------------- admin: approve / reject
    private fun showRequest(e: JSONObject, i: Intent) {
        val isPerson = e.optString("entry_type") != "MATERIAL"
        val root = column(Color.WHITE)

        val head = text(
            (if (isPerson) "🔔  VISITOR AT GATE" else "📦  MATERIAL AT GATE") +
                (e.optString("unit_name").takeIf { it.isNotBlank() }?.let { "\n$it" } ?: ""),
            20f, Color.WHITE, bold = true
        )
        head.setBackgroundColor(Color.parseColor("#D97706"))
        head.setPadding(dp(20), dp(22), dp(20), dp(18))
        root.addView(head, matchWrap())

        val scroll = ScrollView(this)
        val body = column(Color.WHITE).apply { setPadding(dp(20), dp(14), dp(20), dp(10)) }
        scroll.addView(body)
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        val name = e.optString("visitor_name").ifBlank { i.getStringExtra("title") ?: "" }
        body.addView(text(name, 30f, Color.parseColor("#0F172A"), bold = true))
        if (e.optInt("persons_count", 1) > 1) body.addView(text("${e.optInt("persons_count")} persons", 16f, Color.GRAY))

        val photo = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            visibility = View.GONE
        }
        body.addView(photo, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(220)).apply { topMargin = dp(10) })
        if (e.optBoolean("has_photo") || e.optInt("has_photo") == 1) loadPhoto(photo)

        val rows = listOf(
            "Mobile" to e.optString("phone"),
            "Company / from" to e.optString("company"),
            "Purpose" to e.optString("purpose"),
            "To meet" to e.optString("whom_to_meet"),
            "Material" to e.optString("material_desc"),
            "Quantity" to e.optString("material_qty"),
            "Challan / invoice" to e.optString("challan_no"),
            "Vehicle no." to e.optString("vehicle_no"),
            "ID proof" to e.optString("id_proof"),
            "Requested" to listOf(time(e.optString("requested_at")), e.optString("requested_by_name").let { if (it.isNotBlank() && it != "null") "by $it" else "" })
                .filter { it.isNotBlank() }.joinToString(" "),
        )
        for ((k, v) in rows) {
            if (v.isBlank() || v == "null") continue
            body.addView(text(k, 13f, Color.parseColor("#64748B")).apply { setPadding(0, dp(10), 0, 0) })
            body.addView(text(v, 18f, Color.parseColor("#0F172A"), bold = true))
        }
        if (e.length() == 0) body.addView(text(i.getStringExtra("body") ?: "", 18f, Color.DKGRAY))

        val remark = EditText(this).apply {
            hint = "Remark (optional)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            textSize = 17f
        }
        body.addView(remark, matchWrap().apply { topMargin = dp(14) })

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(12), dp(10), dp(12), dp(6))
            setBackgroundColor(Color.WHITE)
        }
        val reject = bigButton("✖  REJECT", "#DC2626")
        val approve = bigButton("✔  APPROVE", "#16A34A")
        buttons.addView(reject, LinearLayout.LayoutParams(0, dp(78), 1f).apply { marginEnd = dp(6) })
        buttons.addView(approve, LinearLayout.LayoutParams(0, dp(78), 1f).apply { marginStart = dp(6) })
        root.addView(buttons, matchWrap())

        val links = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(10))
        }
        links.addView(linkButton("Decide later") { finish() })
        links.addView(linkButton("Open app") { openApp() })
        root.addView(links, matchWrap())

        val decide = { decision: String ->
            stopRing()
            busy = true
            reject.isEnabled = false; approve.isEnabled = false
            (if (decision == "APPROVED") approve else reject).text = "Sending…"
            val json = JSONObject().put("decision", decision).put("remark", remark.text.toString()).toString()
            Api.io.execute {
                val r = Api.request("POST", "/api/entries/$entryId/decision", json)
                runOnUiThread {
                    busy = false
                    when {
                        r.ok -> {
                            Toast.makeText(this, if (decision == "APPROVED") "✔ Approved – guard notified" else "✖ Rejected – guard notified", Toast.LENGTH_LONG).show()
                            finish()
                        }
                        r.code == 409 || r.code == 404 -> { Toast.makeText(this, r.error(), Toast.LENGTH_LONG).show(); finish() }
                        r.code == 401 -> { Toast.makeText(this, "Please open the app and log in again", Toast.LENGTH_LONG).show(); openApp() }
                        else -> {
                            Toast.makeText(this, r.error(), Toast.LENGTH_LONG).show()
                            reject.isEnabled = true; approve.isEnabled = true
                            reject.text = "✖  REJECT"; approve.text = "✔  APPROVE"
                        }
                    }
                }
            }
        }
        reject.setOnClickListener { decide("REJECTED") }
        approve.setOnClickListener { decide("APPROVED") }
        setContentView(root)
    }

    // ---------------------------------------------------------------- guard: green / red
    private fun showResult(ok: Boolean, e: JSONObject, i: Intent) {
        val bg = Color.parseColor(if (ok) "#16A34A" else "#DC2626")
        val root = column(bg).apply { gravity = Gravity.CENTER; setPadding(dp(24), dp(40), dp(24), dp(24)) }
        root.addView(text(if (ok) "✅" else "⛔", 96f, Color.WHITE).apply { gravity = Gravity.CENTER })
        root.addView(text(if (ok) "APPROVED" else "REJECTED", 44f, Color.WHITE, bold = true).apply { gravity = Gravity.CENTER })
        root.addView(text(if (ok) "Allow entry" else "Do NOT allow entry", 24f, Color.WHITE).apply { gravity = Gravity.CENTER })
        val name = e.optString("visitor_name").ifBlank { i.getStringExtra("body") ?: "" }
        root.addView(text(name, 28f, Color.WHITE, bold = true).apply { gravity = Gravity.CENTER; setPadding(0, dp(28), 0, 0) })
        val remark = e.optString("admin_remark")
        if (remark.isNotBlank() && remark != "null") {
            root.addView(text("💬 $remark", 20f, Color.WHITE).apply { gravity = Gravity.CENTER; setPadding(0, dp(12), 0, 0) })
        }
        val by = e.optString("decided_by_name")
        if (by.isNotBlank() && by != "null") {
            root.addView(text("By $by at ${time(e.optString("decided_at"))}", 15f, Color.WHITE).apply { gravity = Gravity.CENTER; alpha = 0.85f; setPadding(0, dp(8), 0, 0) })
        }
        val okBtn = bigButton("OK", "#0F172A")
        okBtn.setOnClickListener { finish() }
        root.addView(okBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(72)).apply { topMargin = dp(36) })
        root.addView(linkButton("Open app", Color.WHITE) { openApp() })
        setContentView(root)
    }

    private fun showSimple(title: String, body: String, bg: Int) {
        val root = column(bg).apply { gravity = Gravity.CENTER; setPadding(dp(24), dp(40), dp(24), dp(24)) }
        root.addView(text(title, 30f, Color.WHITE, bold = true).apply { gravity = Gravity.CENTER })
        root.addView(text(body, 18f, Color.WHITE).apply { gravity = Gravity.CENTER; setPadding(0, dp(16), 0, 0) })
        val okBtn = bigButton("OK", "#0F172A")
        okBtn.setOnClickListener { finish() }
        root.addView(okBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(72)).apply { topMargin = dp(36) })
        setContentView(root)
    }

    // ---------------------------------------------------------------- helpers
    private fun startRing() {
        stopRing()
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(this, uri)?.apply {
                audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
                if (Build.VERSION.SDK_INT >= 28) isLooping = true
                play()
            }
            handler.postDelayed({ stopRing() }, 90_000) // stop ringing after 1.5 minutes
        } catch (e: Exception) { /* no sound available */ }
    }

    fun stopRing() {
        handler.removeCallbacksAndMessages(null)
        try { ringtone?.stop() } catch (e: Exception) { }
        ringtone = null
    }

    private fun openApp() {
        stopRing()
        startActivity(Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("entryId", entryId))
        finish()
    }

    private fun loadPhoto(view: ImageView) {
        val token = Prefs.authToken ?: return
        val id = entryId
        Api.io.execute {
            try {
                val url = URL("${Prefs.serverUrl}/api/entries/$id/photo?t=${URLEncoder.encode(token, "UTF-8")}")
                val c = url.openConnection() as HttpURLConnection
                c.connectTimeout = 15000; c.readTimeout = 20000
                val bmp = c.inputStream.use { BitmapFactory.decodeStream(it) }
                c.disconnect()
                if (bmp != null) runOnUiThread { view.setImageBitmap(bmp); view.visibility = View.VISIBLE }
            } catch (e: Exception) { /* photo is optional */ }
        }
    }

    private fun time(iso: String): String = try {
        val src = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val date = src.parse(iso.take(19))!!
        SimpleDateFormat("hh:mm a", Locale.getDefault()).format(date)
    } catch (e: Exception) { "" }

    private fun column(bg: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(bg)
    }

    private fun matchWrap() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

    private fun text(s: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun bigButton(label: String, color: String) = Button(this).apply {
        text = label
        textSize = 22f
        isAllCaps = false
        setTextColor(Color.WHITE)
        setTypeface(typeface, Typeface.BOLD)
        background = GradientDrawable().apply {
            setColor(Color.parseColor(color))
            cornerRadius = 16 * d
        }
        stateListAnimator = null
    }

    private fun linkButton(label: String, color: Int = Color.parseColor("#2563EB"), onClick: () -> Unit) = Button(this).apply {
        text = label
        textSize = 16f
        isAllCaps = false
        setTextColor(color)
        setBackgroundColor(Color.TRANSPARENT)
        setOnClickListener { onClick() }
    }
}
