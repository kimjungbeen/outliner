// Outliner 안드로이드 앱 — 화면은 WebView, 서버는 앱 안의 파이썬(Chaquopy)이 그대로 돌려요 (Termux 없이)
// 앱 코드(src · plugins)는 assets/app으로 넣고, 켤 때 앱 폴더에 풀어서 그대로 import 해요 (static 파일을 경로로 읽으니까)
import java.time.Instant
import java.time.LocalDate

plugins {
    id("com.android.application")
    id("com.chaquo.python")
}

val outliner = rootDir.resolve("../..").canonicalFile  // outliner/
val gen = layout.buildDirectory.dir("generated/outliner")
val keystore = File(System.getProperty("user.home"), ".android/outliner-release.jks")  // build_apk.sh가 처음 한 번 만들어요 (업데이트하려면 같은 키여야 해요)

android {
    namespace = "app.outliner"
    compileSdk = 35
    defaultConfig {
        applicationId = "app.outliner"
        minSdk = 24
        targetSdk = 35
        versionCode = ((Instant.now().epochSecond - 1_767_225_600L) / 60).toInt()  // 2026-01-01부터 분 — 새로 만들 때마다 커져요
        versionName = LocalDate.now().toString().replace("-", ".")
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    signingConfigs {
        create("release") {
            if (keystore.exists()) {
                storeFile = keystore; storePassword = "outliner"; keyAlias = "outliner"; keyPassword = "outliner"
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystore.exists()) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    sourceSets["main"].assets.srcDir(gen.map { it.dir("assets") })
    sourceSets["main"].res.srcDir(gen.map { it.dir("res") })
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

chaquopy {
    defaultConfig {
        version = "3.12"
        (findProperty("outliner.buildPython") as String?)?.let { buildPython(it) }
        pip { install("flask>=3.0") }
    }
}

// 앱 코드 · 아이콘을 outliner/에서 가져와요 (복사본을 저장소에 두지 않게)
val outlinerFiles by tasks.registering(Sync::class) {
    into(gen)
    from(outliner) {
        include("src/**", "plugins/**")
        exclude("src/mac/**", "**/__pycache__/**", "**/*.pyc")
        into("assets/app")
    }
    from(outliner.resolve("src/static/icon-192.png")) {
        rename { "ic_launcher.png" }
        into("res/mipmap-xxxhdpi")
    }
}
tasks.named("preBuild") { dependsOn(outlinerFiles) }
