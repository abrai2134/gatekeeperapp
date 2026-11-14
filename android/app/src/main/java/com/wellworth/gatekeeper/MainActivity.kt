package com.wellworth.gatekeeper

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/** Shows the Gatekeeper web app and connects it to the phone's full-screen alerts. */
class MainActivity : Activity() {

    companion object {
        @Volatile var isInForeground = false
        @Volatile private var instance: MainActivity? = null

        /** A new alert arrived while the app is open: let the web app refresh and show its popup. */
        fun nudge() {
            val a = instance ?: return
            a.runOnUiThread { a.web.evaluateJavascript("window.gkCatchUp && window.gkCatchUp()", null) }
        }

        private const val REQ_FILE = 11
        private const val REQ_NOTIF = 12
    }

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null
    private var cameraFile: File? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Prefs.init(this)
        instance = this
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString GatekeeperAndroid/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Bridge(), "GatekeeperAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(Prefs.serverUrl)) return false
                // phone numbers, downloads, other sites → open in the right app
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (e: Exception) { }
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) view.loadDataWithBaseURL(null, offlinePage(), "text/html", "utf-8", null)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                openFileChooser(callback, params)
        }
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(startUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getIntExtra("entryId", 0) > 0) web.loadUrl(startUrl(intent))
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        isInForeground = true
        web.evaluateJavascript("window.gkCatchUp && window.gkCatchUp()", null)
    }

    override fun onPause() {
        isInForeground = false
        super.onPause()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    private fun startUrl(i: Intent?): String {
        val id = i?.getIntExtra("entryId", 0) ?: 0
        return Prefs.serverUrl + if (id > 0 && id != Alerts.TEST_ID) "/?entry=$id" else "/"
    }

    private fun offlinePage() = """
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#0f172a">
        <div style="font-size:56px">📶</div><h2>No connection</h2>
        <p>Check mobile data / Wi-Fi and try again.</p>
        <button onclick="location.href='${Prefs.serverUrl}/'" style="font-size:18px;padding:14px 28px;border:0;border-radius:12px;background:#2563eb;color:#fff">Retry</button>
        </body></html>
    """.trimIndent()

    // ---------------------------------------------------------------- camera / photo for the entry form
    private fun openFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        val camera = try {
            val f = File(cacheDir, "photo_${System.currentTimeMillis()}.jpg")
            cameraFile = f
            cameraUri = FileProvider.getUriForFile(this, "$packageName.files", f)
            Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) { null }
        val intent = if (params.isCaptureEnabled && camera != null) camera
        else Intent.createChooser(params.createIntent(), "Photo").apply {
            if (camera != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
        }
        return try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_FILE)
            true
        } catch (e: Exception) {
            fileCallback = null
            false
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE) return
        var result: Array<Uri>? = null
        if (resultCode == RESULT_OK) {
            val picked = data?.data
            result = when {
                picked != null -> arrayOf(picked)
                (cameraFile?.length() ?: 0) > 0 && cameraUri != null -> arrayOf(cameraUri!!)
                else -> null
            }
        }
        fileCallback?.onReceiveValue(result)
        fileCallback = null
    }

    // ---------------------------------------------------------------- phone settings needed for alerts
    private fun notificationsOk(): Boolean {
        val nm = getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return false
        val ch = nm.getNotificationChannel(Alerts.CH_REQUEST)
        return ch == null || ch.importance >= NotificationManager.IMPORTANCE_HIGH
    }

    private fun fullScreenOk(): Boolean =
        if (Build.VERSION.SDK_INT >= 34) getSystemService(NotificationManager::class.java).canUseFullScreenIntent() else true

    private fun batteryOk(): Boolean =
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    private fun openSetting(name: String) {
        val pkg = Uri.parse("package:$packageName")
        val intent = when (name) {
            "notifications" -> {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                    !Prefs.askedNotifPermission
                ) {
                    Prefs.askedNotifPermission = true
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
                    return
                }
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            }
            "fullscreen" -> if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) else null
            "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg)
            "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
            else -> null
        } ?: Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        try {
            startActivity(intent)
        } catch (e: Exception) {
            try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) } catch (e2: Exception) { }
        }
    }

    /** Functions the web app can call: window.GatekeeperAndroid.xxx() */
    inner class Bridge {
        @JavascriptInterface fun isApp(): Boolean = true
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun setSession(token: String, userJson: String) {
            val changed = Prefs.authToken != token
            Prefs.authToken = token
            Prefs.userJson = userJson
            if (changed) Prefs.registeredFor = null
            Push.setup(applicationContext)
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= 33 && !Prefs.askedNotifPermission &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    Prefs.askedNotifPermission = true
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
                }
            }
        }

        @JavascriptInterface
        fun clearSession() {
            Prefs.authToken = null
            Prefs.userJson = null
            Prefs.registeredFor = null
        }

        @JavascriptInterface fun getFcmToken(): String = Prefs.fcmToken ?: ""

        @JavascriptInterface
        fun alertStatus(): String = JSONObject()
            .put("notifications", notificationsOk())
            .put("fullScreen", fullScreenOk())
            .put("overlay", Settings.canDrawOverlays(this@MainActivity))
            .put("battery", batteryOk())
            .put("registered", Push.isRegistered)
            .put("error", Push.lastError ?: "")
            .put("brand", Build.MANUFACTURER)
            .toString()

        @JavascriptInterface fun openSetting(name: String) = runOnUiThread { this@MainActivity.openSetting(name) }
        @JavascriptInterface fun retryRegister() = Push.setup(applicationContext)
    }
}
