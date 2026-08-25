package com.aureon.ai;

import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;

/**
 * Android calls this to create a new VoiceInteractionSession every time the
 * assistant is invoked (wake word detected, long-press home, etc).
 */
public class AureonVoiceInteractionSessionService extends VoiceInteractionSessionService {

    @Override
    public VoiceInteractionSession onNewSession(android.os.Bundle args) {
        return new AureonVoiceInteractionSession(this);
    }
}
