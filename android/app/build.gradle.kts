plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Server the app opens. Change with: ./gradlew assembleRelease -PserverUrl=https://your-server
val serverUrl = (findProperty("serverUrl") as String?) ?: "https://wellworthgatekeeperapp.onrender.com"
val buildNumber = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
val keystorePath: String? = System.getenv("KEYSTORE_FILE")

android {
    namespace = "com.wellworth.gatekeeper"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.wellworth.gatekeeper"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
    }
    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            if (keystorePath != null && file(keystorePath).exists()) {
                storeFile = file(keystorePath)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
}
