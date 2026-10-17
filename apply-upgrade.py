#!/usr/bin/env python3
"""Aureon Upgrade 3 - ONE zip, ONE command:  unzip -o Upgrade-3.zip && python3 apply-upgrade.py
Runs, in the right order: v9 (multi-photo, old-chat fix, full screen, Ava Mind, Ava Lab) -> Ava teach -> security server patch -> phone guard.
Every step is idempotent (safe to run again)."""
import subprocess, sys
steps = [['apply-v9.py'], ['apply-ava-teach.py'], ['apply-server-patch.py', 'backend/server.js'], ['apply-phone-guard.py']]
for s in steps:
    print('\n=== ' + ' '.join(s))
    if subprocess.call([sys.executable] + s) != 0:
        sys.exit('STOPPED at: ' + ' '.join(s) + '  (send me this output)')
print('\nUpgrade 3 applied.')
