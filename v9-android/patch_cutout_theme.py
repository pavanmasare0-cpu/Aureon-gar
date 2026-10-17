#!/usr/bin/env python3
"""Aureon full-screen, part 2 (theme level). Run from repo root. Idempotent.
Some phones (OPPO/ColorOS, Vivo, Realme) keep a black strip over the camera-notch area unless the APP THEME itself says
"draw into the cutout". This adds android/app/src/main/res/values-v28/styles.xml (a NEW file; nothing in res/ is edited,
no backup files are created inside res/ because Gradle rejects them)."""
import os, sys, xml.dom.minidom
D = 'android/app/src/main/res/values-v28'
P = D + '/styles.xml'
if not os.path.isdir('android/app/src/main/res'): sys.exit('ERROR: run from the repo root (android/app/src/main/res not found)')
xml_text = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Android 9+: draw behind the camera notch / punch-hole and behind the (hidden) bars -> no black strip on top. -->
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:enforceNavigationBarContrast">false</item>
        <item name="android:enforceStatusBarContrast">false</item>
    </style>
</resources>
'''
xml.dom.minidom.parseString(xml_text)   # must be well-formed
if os.path.exists(P) and open(P, encoding='utf8').read() == xml_text: print('ok, already done: values-v28/styles.xml'); sys.exit(0)
os.makedirs(D, exist_ok=True); open(P, 'w', encoding='utf8').write(xml_text); print('wrote ' + P)
