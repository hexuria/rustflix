import java.util.Properties

plugins {
    id("com.android.application")
}

// One version for both phone apps: MARKETING_VERSION / CURRENT_PROJECT_VERSION
// of ios/project.yml become versionName / versionCode (bump it there).
val iosProject = rootProject.file("../ios/project.yml").readText()
fun iosSetting(name: String): String =
    Regex("""$name:\s*"?([^"\s]+)"?""").find(iosProject)?.groupValues?.get(1)
        ?: error("ios/project.yml has no $name")

// The NSH runtime build.sh stages from the NSH repository
// (`cargo xtask android --release`): classes.jar and jni/<abi>/libnsh.so
// (with symbols; the build strips what it packages and keeps them for
// Play Console's native crash reports).
val nshRuntime = rootProject.file("nsh-runtime")

// Release signing with the upload key: android/keystore.properties (never
// committed) names storeFile and keyAlias; the passwords come from the
// environment (RUSTFLIX_UPLOAD_STORE_PASSWORD / RUSTFLIX_UPLOAD_KEY_PASSWORD,
// which build.sh reads from the Keychain) or, failing that, the same file's
// storePassword / keyPassword. Without the file a release build is unsigned.
val keystoreFile = rootProject.file("keystore.properties")
val keystore = Properties().apply { if (keystoreFile.exists()) keystoreFile.inputStream().use { load(it) } }
fun secretOf(env: String, key: String): String? = System.getenv(env)?.takeIf { it.isNotEmpty() } ?: keystore.getProperty(key)

val abis = (project.findProperty("abis") as String?)?.split(",")
    ?: listOf("arm64-v8a", "armeabi-v7a", "x86_64")
val abiSplits = project.hasProperty("abiSplits")

android {
    namespace = "com.hexuria.rustflix"
    compileSdk = 36
    // The NDK whose llvm-strip strips libnsh.so (the one NSH builds with).
    ndkVersion = "29.0.13113456"

    defaultConfig {
        applicationId = "com.hexuria.rustflix"
        minSdk = 26 // NSH's minimum (Android 8.0)
        targetSdk = 36
        versionCode = iosSetting("CURRENT_PROJECT_VERSION").toInt()
        versionName = iosSetting("MARKETING_VERSION")
        // Which ABIs go into the APK/AAB: -Pabis=arm64-v8a,x86_64 (default:
        // all staged). With -PabiSplits the splits below choose instead.
        if (!abiSplits) ndk { abiFilters += abis }
    }

    signingConfigs {
        if (keystore.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = secretOf("RUSTFLIX_UPLOAD_STORE_PASSWORD", "storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = secretOf("RUSTFLIX_UPLOAD_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
        }
    }

    // One APK per ABI with -PabiSplits (direct downloads); the AAB never
    // needs it (Play splits by ABI itself).
    splits {
        abi {
            isEnable = abiSplits
            reset()
            include(*abis.toTypedArray())
            isUniversalApk = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            jniLibs.directories.add(nshRuntime.resolve("jni").path)
            // librustflix_dl.so (android/rustflix-dl, staged by build.sh).
            jniLibs.directories.add(rootProject.file("dl-runtime/jni").path)
        }
    }

    packaging {
        // Uncompressed, page-aligned native libraries (16 KB pages on Android 15+).
        jniLibs.useLegacyPackaging = false
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(files(nshRuntime.resolve("classes.jar")))
    // The app's own video player (`rustflix.video`, NativeVideo.java):
    // ExoPlayer with HLS, and a MediaSession for headset / system media
    // controls. No media3-ui (the app draws its own controls).
    val media3 = "1.11.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-session:$media3")
}
