#!/bin/bash
set -e

ANDROID_SDK="$HOME/Android/Sdk"
CMDLINE_TOOLS_ZIP="commandlinetools-linux-14742923_latest.zip"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║        SMSTracker Local APK Builder              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Install Android SDK if missing ──────────────────────────────────
if [ ! -f "$ANDROID_SDK/platform-tools/adb" ]; then
  echo "📦 Android SDK not found. Installing command-line tools..."
  mkdir -p "$ANDROID_SDK/cmdline-tools"

  if [ ! -f "/tmp/$CMDLINE_TOOLS_ZIP" ]; then
    echo "⬇️  Downloading SDK tools (~140MB)..."
    curl -L "$CMDLINE_TOOLS_URL" -o "/tmp/$CMDLINE_TOOLS_ZIP" --progress-bar
  else
    echo "✅ SDK tools zip already cached."
  fi

  echo "📂 Extracting..."
  unzip -q "/tmp/$CMDLINE_TOOLS_ZIP" -d "$ANDROID_SDK/cmdline-tools/"
  # Rename 'cmdline-tools' folder to 'latest' (required by sdkmanager)
  mv "$ANDROID_SDK/cmdline-tools/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest" 2>/dev/null || true

  export PATH="$ANDROID_SDK/cmdline-tools/latest/bin:$ANDROID_SDK/platform-tools:$PATH"
  export ANDROID_HOME="$ANDROID_SDK"
  export ANDROID_SDK_ROOT="$ANDROID_SDK"

  echo "📜 Accepting SDK licenses..."
  yes | sdkmanager --licenses > /dev/null 2>&1 || true

  echo "📲 Installing platform-tools + build-tools + platform 34..."
  sdkmanager "platform-tools" "build-tools;34.0.0" "platforms;android-34"
  echo "✅ Android SDK installed at $ANDROID_SDK"
else
  echo "✅ Android SDK already installed."
fi

# ── Step 2: Set env vars ─────────────────────────────────────────────────────
export ANDROID_HOME="$ANDROID_SDK"
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export PATH="$ANDROID_SDK/cmdline-tools/latest/bin:$ANDROID_SDK/platform-tools:$ANDROID_SDK/build-tools/34.0.0:$PATH"

# ── Step 3: Install JS dependencies if needed ────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "📦 Installing JS dependencies..."
  npm install
fi

# ── Step 4: Bundle JS (Metro) ────────────────────────────────────────────────
echo ""
echo "📦 Bundling React Native JS..."
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.ts \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res/

# ── Step 5: Build APK with Gradle ───────────────────────────────────────────
echo ""
echo "🔨 Building APK with Gradle (this may take a few minutes the first time)..."
cd android
chmod +x gradlew
./gradlew assembleRelease --no-daemon 2>&1 | tail -30

# ── Step 6: Locate APK ───────────────────────────────────────────────────────
cd ..
APK_PATH=$(find android/app/build/outputs/apk -name "*.apk" | head -1)
if [ -z "$APK_PATH" ]; then
  # Fallback to debug
  cd android && ./gradlew assembleDebug --no-daemon 2>&1 | tail -20 && cd ..
  APK_PATH=$(find android/app/build/outputs/apk -name "*.apk" | head -1)
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ BUILD COMPLETE!                              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "📱 APK ready at:"
echo "   $PWD/$APK_PATH"
echo ""
echo "Transfer to phone:"
echo "  adb install -r $APK_PATH"
echo "  OR copy the APK file to your phone manually."
echo ""
