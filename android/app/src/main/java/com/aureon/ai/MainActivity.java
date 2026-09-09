package com.aureon.ai;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.content.Intent;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_PERMISSIONS = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before super.onCreate() so the Capacitor bridge
        // picks it up.
        // - AureonSpeechPlugin: native offline speech-to-text + on-device
        //   command execution, exposed to the chat screen's mic button.
        // - AureonActionsPlugin: JS-callable bridge for agent actions
        //   (open_app, get_battery, set_alarm, search_web, open_url,
        //   play_music, and the new send-message flow) — see
        //   AureonAgentActions.java.
        registerPlugin(AureonSpeechPlugin.class);
        registerPlugin(AureonActionsPlugin.class);

        super.onCreate(savedInstanceState);

        List<String> needed = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }

        // Needed so voice commands like "message Pavan saying ..." can look
        // up a contact's number and open WhatsApp/SMS/Instagram with it.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_CONTACTS);
        }

        // "recent message padho" — reads the latest text message without
        // opening any app.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_SMS);
        }

        // "send location to Pavan" — needed to read the phone's last known
        // GPS/network fix so it can be shared as a Maps link.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }

        // "kiska call hai" (caller-ID announcement) and "call uthao" (voice
        // answer) both need to know a call is ringing; READ_CALL_LOG is
        // additionally required on Android 9+ for the incoming number to
        // actually be included in the system broadcast.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_PHONE_STATE);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_CALL_LOG);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS);
            }
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(
                    this,
                    needed.toArray(new String[0]),
                    REQUEST_PERMISSIONS
            );
        } else {
            promptPhase6Setup();
        }

        startCallListenerService();
    }

    /**
     * Starts the persistent foreground service backing caller-ID
     * announcement. Called unconditionally on every launch — Android will
     * simply no-op if it's already running. This doesn't require the
     * phone-state permissions to be granted yet; it just gets the
     * always-on listener in place so announcements work as soon as the
     * user does grant them.
     */
    private void startCallListenerService() {
        try {
            ContextCompat.startForegroundService(this, new Intent(this, AureonCallListenerService.class));
        } catch (Exception ignored) {
            // Best-effort — if this fails for any reason, the manifest-
            // declared AureonCallReceiver is still there as a fallback.
        }
    }

    private void promptPhase6Setup() {
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Aureon voice permissions")
                .setMessage("For voice typing and app actions (open apps, send messages with your confirmation), enable Aureon's Accessibility Service.\n\nFor system-wide \"Hey Aureon\", also set Aureon as your Default Digital Assistant.")
                .setPositiveButton("Accessibility", (d, w) -> {
                    try { startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); }
                    catch (Exception e) { Toast.makeText(this, "Open Settings \u2192 Accessibility \u2192 Aureon", Toast.LENGTH_LONG).show(); }
                })
                .setNeutralButton("Default Assistant", (d, w) -> {
                    try { startActivity(new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)); }
                    catch (Exception e) { Toast.makeText(this, "Set Aureon as Default Digital Assistant in Settings", Toast.LENGTH_LONG).show(); }
                })
                .setNegativeButton("Later", null)
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_PERMISSIONS) promptPhase6Setup();
    }
}
