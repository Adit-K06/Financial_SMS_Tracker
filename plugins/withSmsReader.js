/**
 * Expo Config Plugin: withSmsReader
 *
 * Injects the custom native SmsReader Kotlin module into the generated
 * Android project during `expo prebuild` / EAS build.
 *
 * It does three things:
 *  1. Writes SmsReaderModule.kt into the app's Kotlin source directory
 *  2. Writes SmsReaderPackage.kt into the app's Kotlin source directory
 *  3. Patches MainApplication.kt to register SmsReaderPackage()
 */

const {
  withMainApplication,
  withDangerousMod,
  createRunOncePlugin,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// ─── Kotlin source files ────────────────────────────────────────────────────

const SMS_READER_MODULE = `package com.adit.smstracker

import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import org.json.JSONArray
import org.json.JSONObject

class SmsReaderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SmsReader"

    @ReactMethod
    fun list(filterJson: String, fail: Callback, success: Callback) {
        try {
            val context = reactApplicationContext

            if (ContextCompat.checkSelfPermission(
                    context,
                    android.Manifest.permission.READ_SMS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                fail.invoke("READ_SMS permission not granted")
                return
            }

            val maxCount: Int = try {
                JSONObject(filterJson).optInt("maxCount", 50)
            } catch (e: Exception) {
                50
            }

            val uri = Uri.parse("content://sms/inbox")
            val projection = arrayOf("_id", "address", "body", "date", "read")

            val cursor = context.contentResolver.query(
                uri, projection, null, null, "date DESC LIMIT \$maxCount"
            )

            val resultArray = JSONArray()

            cursor?.use { c ->
                val idIdx    = c.getColumnIndex("_id")
                val addrIdx  = c.getColumnIndex("address")
                val bodyIdx  = c.getColumnIndex("body")
                val dateIdx  = c.getColumnIndex("date")
                val readIdx  = c.getColumnIndex("read")

                while (c.moveToNext()) {
                    val obj = JSONObject()
                    obj.put("_id",     if (idIdx   >= 0) c.getString(idIdx)   ?: "" else "")
                    obj.put("address", if (addrIdx  >= 0) c.getString(addrIdx) ?: "" else "")
                    obj.put("body",    if (bodyIdx  >= 0) c.getString(bodyIdx) ?: "" else "")
                    obj.put("date",    if (dateIdx  >= 0) c.getLong(dateIdx)   else 0L)
                    obj.put("read",    if (readIdx  >= 0) c.getInt(readIdx)    else 0)
                    resultArray.put(obj)
                }
            }

            success.invoke(resultArray.length(), resultArray.toString())
        } catch (e: Exception) {
            fail.invoke(e.message ?: "Unknown error reading SMS")
        }
    }
}
`;

const SMS_READER_PACKAGE = `package com.adit.smstracker

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SmsReaderPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(SmsReaderModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

// ─── Plugin logic ────────────────────────────────────────────────────────────

/**
 * Step 1 & 2: Write the two Kotlin files into the generated android project.
 */
function withSmsReaderFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const packageDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        'com',
        'adit',
        'smstracker'
      );

      // Make sure the directory exists (prebuild creates it, but be safe)
      fs.mkdirSync(packageDir, { recursive: true });

      fs.writeFileSync(
        path.join(packageDir, 'SmsReaderModule.kt'),
        SMS_READER_MODULE,
        'utf8'
      );

      fs.writeFileSync(
        path.join(packageDir, 'SmsReaderPackage.kt'),
        SMS_READER_PACKAGE,
        'utf8'
      );

      return cfg;
    },
  ]);
}

/**
 * Step 3: Patch MainApplication.kt to register SmsReaderPackage().
 *
 * withMainApplication gives us the file contents as a string; we just
 * insert our package into the PackageList block.
 */
function withSmsReaderPackage(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // Only patch if not already patched (idempotent)
    if (contents.includes('SmsReaderPackage()')) {
      return cfg;
    }

    // After PackageList(this).packages.apply { insert our add() call
    const applyBlock = 'PackageList(this).packages.apply {';
    const insertion  = `${applyBlock}\n          // Custom native SMS reader\n          add(SmsReaderPackage())`;

    if (!contents.includes(applyBlock)) {
      console.warn('[withSmsReader] Could not find PackageList apply block — skipping patch');
      return cfg;
    }

    contents = contents.replace(applyBlock, insertion);
    cfg.modResults.contents = contents;
    return cfg;
  });
}

/**
 * Compose both mods into one plugin.
 */
const withSmsReader = (config) => {
  config = withSmsReaderFiles(config);
  config = withSmsReaderPackage(config);
  return config;
};

module.exports = createRunOncePlugin(withSmsReader, 'withSmsReader', '1.0.0');
