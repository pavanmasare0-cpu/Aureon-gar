#!/usr/bin/env python3
"""Run once from the repo root after unzipping Aureon-v9.zip:  python3 apply-v9.py
Order: apply-all.py (ui-fix, panel, v2 patches) -> app photos/old-chat fix -> backend multi-photo -> Android full screen.
Every step is idempotent and keeps .bak copies. If a step cannot find its anchor it stops and says what to send."""
import subprocess, sys, os
here = os.path.dirname(os.path.abspath(__file__))
steps = [('apply-all.py', 'ui-fix + panel + v2 patches'), ('v9-app/patch_app.py', 'many photos + old-chat fix'),
         ('v9-backend/patch_server.py', 'backend: many photos per message'), ('v9-android/patch_fullscreen.py', 'Android full screen'),
         ('v9-android/patch_cutout_theme.py', 'Android full screen (theme: draw into notch area)'),
         ('v9-sentinel/patch_ava_lab.py', 'Ava Lab (self-upgrade dashboard in Sentinel)')]
for script, label in steps:
    print('\n== %s  (%s)' % (script, label))
    if subprocess.run([sys.executable, os.path.join(here, script)]).returncode:
        print('\nSTOPPED at', script, '- send me the message above'); sys.exit(1)
print('\nALL DONE')
