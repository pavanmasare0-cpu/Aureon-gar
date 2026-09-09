package com.aureon.ai;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Manifest-declared backup path for caller-ID announcement. On phones like
 * ColorOS/Realme this alone can be unreliable (the OS kills/limits the app
 * before it fires), which is why AureonCallListenerService ALSO listens
 * for the same broadcast via a dynamically-registered receiver kept alive
 * by a foreground notification. Both funnel into the same shared logic in
 * AureonCallAnnouncer, so whichever one actually fires does the job.
 */
public class AureonCallReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        AureonCallAnnouncer.handlePhoneStateIntent(context, intent);
    }
}
