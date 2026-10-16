#!/usr/bin/env python3
"""Run once from the repo root after unzipping Aureon-ava-all.zip:  python3 apply-all.py
Runs, in order: fix-ava-ui.py -> apply-ava-panel.py -> apply-ava-v2.py (all idempotent, make .bak files)."""
import subprocess, sys
for s in ('fix-ava-ui.py', 'apply-ava-panel.py', 'apply-ava-v2.py'):
    print('\n==', s)
    if subprocess.run([sys.executable, s]).returncode:
        print('\nSTOPPED at', s, '- send me the message above'); sys.exit(1)
print('\nALL DONE')
