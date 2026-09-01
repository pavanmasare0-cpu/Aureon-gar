# Wake-word models go here

Drop these 3 files into this folder before building the APK:

1. `melspectrogram.onnx` — shared, download from the openWakeWord repo
   releases (same file works for openWakeWord AND ViolaWake models, since
   ViolaWake is built on the openWakeWord embedding backbone).
   https://github.com/dscripka/openWakeWord/releases

2. `embedding_model.onnx` — shared, same source as above.

3. `aureon.onnx` — your custom trained wake-word model for "Aureon".
   Train it with EITHER:
   - openWakeWord's Colab notebook (free GPU, ~1hr):
     https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb
   - ViolaWake Console or CLI (record your own voice, free):
     https://violawake.com/register
     `pip install "violawake[oww]"`
     `violawake-train --word "aureon" --positives samples/ --output aureon.onnx`

Once all 3 files are in this folder, `npx cap sync android` then build the
APK as usual — WakeWordDetector.java loads them automatically at runtime.
