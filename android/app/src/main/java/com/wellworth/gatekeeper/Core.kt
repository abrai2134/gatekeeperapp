package com.wellworth.gatekeeper

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

const val TAG = "Gatekeeper"

class GatekeeperApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Alerts.createChannels(this)
        Push.initFirebase(this)
    }
}

/** Small key-value store for the login token and Firebase settings. */
object Prefs {
    private lateinit var sp: SharedPreferences
    fun init(c: Context) {
        if (!::sp.isInitialized) sp = c.applicationContext.getSharedPreferences("gatekeeper", Context.MODE_PRIVATE)
    }
    private fun str(k: String): String? = sp.getString(k, null)
    private fun put(k: String, v: String?) = sp.edit().putString(k, v).apply()

    var authToken: String? get() = str("auth"); set(v) = put("auth", v)
    var userJson: String? get() = str("user"); set(v) = put("user", v)
    var firebaseConfig: String? get() = str("fbcfg"); set(v) = put("fbcfg", v)
    var fcmToken: String? get() = str("fcm"); set(v) = put("fcm", v)
    /** login token for which the current FCM token was registered on the server */
    var registeredFor: String? get() = str("regfor"); set(v) = put("regfor", v)
    var askedNotifPermission: Boolean
        get() = sp.getBoolean("asked_notif", false)
        set(v) = sp.edit().putBoolean("asked_notif", v).apply()

    val serverUrl: String get() = BuildConfig.SERVER_URL.trimEnd('/')
}

/** Minimal JSON-over-HTTPS client (runs on background threads). */
object Api {
    val io: ExecutorService = Executors.newCachedThreadPool()

    class Resp(val code: Int, val body: String) {
        val ok get() = code in 200..299
        fun error(): String = try {
            JSONObject(body).optString("error", "Error $code")
        } catch (e: Exception) {
            if (code == -1) "No internet / server not reachable" else "Error $code"
        }
    }

    fun request(method: String, path: String, json: String? = null, token: String? = Prefs.authToken): Resp {
        return try {
            val c = URL(Prefs.serverUrl + path).openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 15000
            c.readTimeout = 30000
            c.setRequestProperty("Accept", "application/json")
            if (token != null) c.setRequestProperty("Authorization", "Bearer $token")
            if (json != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(json.toByteArray()) }
            }
            val code = c.responseCode
            val stream = if (code < 400) c.inputStream else c.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            c.disconnect()
            Resp(code, body)
        } catch (e: Exception) {
            Log.w(TAG, "request $path failed", e)
            Resp(-1, "")
        }
    }
}

/** Firebase setup + registering this phone with the Gatekeeper server. */
object Push {
    @Volatile var lastError: String? = null

    val isRegistered: Boolean
        get() = Prefs.authToken != null && Prefs.registeredFor == Prefs.authToken && Prefs.fcmToken != null

    /** Start Firebase with settings cached from the server (needed when a message wakes the app). */
    fun initFirebase(ctx: Context): Boolean {
        if (FirebaseApp.getApps(ctx).isNotEmpty()) return true
        val cfg = Prefs.firebaseConfig ?: return false
        return try {
            val j = JSONObject(cfg)
            val options = FirebaseOptions.Builder()
                .setApplicationId(j.getString("appId"))
                .setApiKey(j.getString("apiKey"))
                .setProjectId(j.getString("projectId"))
                .setGcmSenderId(j.getString("senderId"))
                .build()
            FirebaseApp.initializeApp(ctx.applicationContext, options)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Firebase init failed", e)
            lastError = "Firebase start failed: ${e.message}"
            false
        }
    }

    /** Called after login: fetch Firebase settings if needed, get the FCM token and send it to the server. */
    fun setup(ctx: Context) {
        Api.io.execute {
            if (!initFirebase(ctx)) {
                val r = Api.request("GET", "/api/android/config", token = null)
                if (!r.ok) {
                    lastError = r.error()
                    return@execute
                }
                Prefs.firebaseConfig = r.body
                if (!initFirebase(ctx)) return@execute
            }
            try {
                FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                    if (t.isSuccessful && t.result != null) {
                        if (t.result != Prefs.fcmToken) Prefs.registeredFor = null
                        Prefs.fcmToken = t.result
                        register()
                    } else {
                        lastError = "Could not get alert token: ${t.exception?.message}"
                    }
                }
            } catch (e: Exception) {
                lastError = "Could not get alert token: ${e.message}"
            }
        }
    }

    fun register() {
        Api.io.execute {
            val tok = Prefs.fcmToken ?: return@execute
            val auth = Prefs.authToken ?: return@execute
            val r = Api.request("POST", "/api/push/fcm", JSONObject().put("token", tok).toString(), auth)
            if (r.ok) {
                Prefs.registeredFor = auth
                lastError = if (JSONObject(r.body).optBoolean("enabled", true)) null
                else "Server: Firebase service account not set up yet"
            } else {
                lastError = r.error()
            }
        }
    }
}
