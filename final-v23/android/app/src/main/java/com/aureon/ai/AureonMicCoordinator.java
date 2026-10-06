package com.aureon.ai;

/**
 * Mic coordination between the two things that each want the microphone:
 * AureonVoiceInteractionService (background wake-word polling, "Aureon")
 * and AureonVoiceInteractionSession (the actual conversation, once
 * invoked). Android only lets one SpeechRecognizer own the mic at a time —
 * without this, the background listener would blindly resume polling 8s
 * after showing the session, regardless of whether the conversation was
 * still going, stealing the mic mid-sentence and repeatedly grabbing audio
 * focus (which is what was pausing music and breaking a second command
 * within the same session).
 *
 * A plain static volatile flag is enough here — both classes run in the
 * same process, and this only ever needs a single reader/writer at a time
 * (no complex synchronization required for a simple on/off signal).
 */
public class AureonMicCoordinator {
    private static volatile boolean sessionActive = false;

    private AureonMicCoordinator() {}

    public static void setSessionActive(boolean active) {
        sessionActive = active;
    }

    public static boolean isSessionActive() {
        return sessionActive;
    }
}
