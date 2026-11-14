package com.wellworth.gatekeeper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/** Receives alerts from the server (Firebase) even when the app is closed. */
class GateMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Prefs.init(this)
        Prefs.fcmToken = token
        Prefs.registeredFor = null
        Push.register()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Prefs.init(this)
        Alerts.handle(this, message.data)
    }
}

object Alerts {
    const val CH_REQUEST = "gate_requests"
    const val CH_RESULT = "gate_results"
    const val TEST_ID = 999_999

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val alarmAttrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val request = NotificationChannel(CH_REQUEST, "Gate entry requests", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Rings and shows a full-screen alert when a visitor or material is waiting at the gate"
            setSound(alarmSound, alarmAttrs)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 700, 300, 700, 300, 700)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(true)
        }
        val result = NotificationChannel(CH_RESULT, "Approve / reject results", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Full-screen green / red alert when the admin approves or rejects"
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(true)
        }
        nm.createNotificationChannels(listOf(request, result))
    }

    fun cancel(ctx: Context, id: Int) {
        ctx.getSystemService(NotificationManager::class.java).cancel(id)
    }

    fun handle(ctx: Context, payload: Map<String, String>) {
        val kind = payload["kind"] ?: return
        val id = if (kind == "test") TEST_ID else payload["entryId"]?.toIntOrNull() ?: return
        if (kind == "closed") {
            // another admin already decided – stop ringing here
            cancel(ctx, id)
            AlertActivity.closeIfShowing(id, payload["by"])
            return
        }
        if (MainActivity.isInForeground && kind != "test") {
            // app is open on screen: the app itself shows the big popup
            MainActivity.nudge()
            return
        }
        val isRequest = kind == "request" || kind == "test"
        val alertIntent = Intent(ctx, AlertActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            for ((k, v) in payload) putExtra(k, v)
            putExtra("notifId", id)
        }
        val fullScreen = PendingIntent.getActivity(
            ctx, id, alertIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = Notification.Builder(ctx, if (isRequest) CH_REQUEST else CH_RESULT)
            .setSmallIcon(R.drawable.ic_stat_gate)
            .setColor(if (kind == "rejected") 0xFFDC2626.toInt() else if (kind == "approved") 0xFF16A34A.toInt() else 0xFFD97706.toInt())
            .setContentTitle(payload["title"] ?: "Gatekeeper")
            .setContentText(payload["body"] ?: "")
            .setStyle(Notification.BigTextStyle().bigText(payload["body"] ?: ""))
            .setCategory(if (isRequest) Notification.CATEGORY_CALL else Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
            .setAutoCancel(true)
            .setShowWhen(true)
        if (kind == "request") {
            b.addAction(action(ctx, id, "REJECTED", "✖ Reject"))
            b.addAction(action(ctx, id, "APPROVED", "✔ Approve"))
        }
        val n = b.build()
        if (kind == "request") n.flags = n.flags or Notification.FLAG_INSISTENT // keeps ringing until handled
        try {
            ctx.getSystemService(NotificationManager::class.java).notify(id, n)
        } catch (e: SecurityException) {
            Log.w(TAG, "notification permission missing", e)
        }
        // With "Display over other apps" allowed, open the big screen right away, even while the phone is in use
        if (Settings.canDrawOverlays(ctx)) {
            try { ctx.startActivity(alertIntent) } catch (e: Exception) { Log.w(TAG, "could not open alert", e) }
        }
    }

    private fun action(ctx: Context, id: Int, decision: String, label: String): Notification.Action {
        val i = Intent(ctx, DecisionReceiver::class.java)
            .putExtra("entryId", id)
            .putExtra("decision", decision)
        val pi = PendingIntent.getBroadcast(
            ctx, id * 2 + if (decision == "APPROVED") 1 else 0, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Action.Builder(Icon.createWithResource(ctx, R.drawable.ic_stat_gate), label, pi).build()
    }
}

/** Approve / Reject buttons directly on the notification. */
class DecisionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Prefs.init(ctx)
        val id = intent.getIntExtra("entryId", 0)
        val decision = intent.getStringExtra("decision") ?: return
        val pending = goAsync()
        Api.io.execute {
            try {
                val r = Api.request("POST", "/api/entries/$id/decision", JSONObject().put("decision", decision).toString())
                val msg = when {
                    r.ok -> if (decision == "APPROVED") "✔ Approved – guard notified" else "✖ Rejected – guard notified"
                    else -> r.error()
                }
                Alerts.cancel(ctx, id)
                AlertActivity.closeIfShowing(id, null)
                Handler(Looper.getMainLooper()).post { Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show() }
            } finally {
                pending.finish()
            }
        }
    }
}
