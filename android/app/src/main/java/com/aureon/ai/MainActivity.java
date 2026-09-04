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
        // picks it up. Exposes native offline speech-to-text + on-device
        // command execution to the chat screen's mic button.
        registerPlugin(AureonSpeechPlugin.class);

        super.onCreate(savedInstanceState);

        List<String> needed = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }

        // Needed so voice commands like "message Pavan saying ..." can look
        // up a contact's number and open WhatsApp/SMS with it.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_CONTACTS);
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
    }

    private void promptPhase6Setup() {
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Aureon voice permissions")
                .setMessage("For Phase 6 voice typing and phone actions, enable Aureon's Accessibility Service.\n\nFor system-wide \"Hey Aureon\", also set Aureon as your Default Digital Assistant.")
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
