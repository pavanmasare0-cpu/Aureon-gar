package com.aureon.ai;

import android.content.Context;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Fills the form on the foreground screen from the user's Application
 * Profile (answers come from the backend, /api/form-fill). Shared by the
 * in-app chat (AureonActionsPlugin) and the "Hey Aureon" voice overlay.
 * Blocking — call it off the main thread. NEVER taps Submit/Apply.
 */
public final class AureonFormFiller {
    private AureonFormFiller() {}

    private static final int MAX_SCREENS = 12;
    private static final int BATCH = 30;

    private static void sleep(int ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) {}
    }

    private static boolean looksLikePlaceholder(String cur) {
        String c = cur == null ? "" : cur.trim().toLowerCase(Locale.ROOT);
        return c.isEmpty() || c.contains("select") || c.contains("choose") || c.contains("pick")
                || c.contains("please") || c.startsWith("--") || c.equals("none");
    }

    public static JSONObject run(Context ctx, String backendBase, boolean enforceNotAureon)
            throws AureonAgentActions.ActionException {
        if (!AureonAccessibilityService.isEnabled()) {
            throw new AureonAgentActions.ActionException(
                    "Aureon's Accessibility Service isn't turned on yet. Enable it in Settings \u2192 Accessibility \u2192 Aureon, then try again.");
        }
        String token = AureonAgentActions.getFreshIdToken(ctx);
        if (token == null) {
            throw new AureonAgentActions.ActionException("Aureon mein login nahi mila — app kholke ek baar login karo.");
        }
        String base = backendBase.endsWith("/") ? backendBase.substring(0, backendBase.length() - 1) : backendBase;

        try {
            int filled = 0;
            JSONArray skipped = new JSONArray();
            Set<String> skippedSeen = new HashSet<>();
            String lastSig = null;
            int screens = 0;

            for (; screens < MAX_SCREENS; screens++) {
                if (enforceNotAureon && "com.aureon.ai".equals(AureonAccessibilityService.activePackage())) {
                    throw new AureonAgentActions.ActionException(
                            "Form wala page foreground mein nahi tha — pehle form kholo, phir dobara bolo.");
                }
                JSONArray raw = new JSONArray(AureonAccessibilityService.scanForm());

                if (screens == 0 && AureonAccessibilityService.lastScanSawPassword() && raw.length() <= 2) {
                    return new JSONObject()
                            .put("filled", 0).put("skipped", new JSONArray()).put("screens", 1)
                            .put("loginRequired", true)
                            .put("note", "This page is asking the user to log in. Nothing was filled. The user must log in themselves, then ask you to fill the form (fill_application_form without a url).");
                }

                StringBuilder sig = new StringBuilder();
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject e = raw.getJSONObject(i);
                    sig.append(e.optString("type")).append(e.optInt("index")).append(':')
                            .append(e.optString("label", e.optString("option"))).append('|');
                }
                String sigStr = sig.toString();
                if (screens > 0 && sigStr.equals(lastSig)) break; // page didn't move: reached the end
                lastSig = sigStr;

                // Group consecutive radio buttons that share the same question label.
                List<JSONObject> units = new ArrayList<>();
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject e = raw.getJSONObject(i);
                    if ("radio".equals(e.optString("type"))) {
                        String group = e.optString("group", "");
                        JSONObject last = units.isEmpty() ? null : units.get(units.size() - 1);
                        if (last != null && "radio".equals(last.optString("type")) && last.optString("label").equals(group)) {
                            last.getJSONArray("options").put(e.optString("option"));
                            last.getJSONArray("optIdx").put(e.getInt("index"));
                            if (e.optBoolean("checked")) last.put("anyChecked", true);
                        } else {
                            JSONObject u = new JSONObject();
                            u.put("type", "radio").put("index", e.getInt("index")).put("label", group)
                                    .put("options", new JSONArray().put(e.optString("option")))
                                    .put("optIdx", new JSONArray().put(e.getInt("index")))
                                    .put("anyChecked", e.optBoolean("checked"));
                            units.add(u);
                        }
                    } else {
                        units.add(e);
                    }
                }

                JSONArray asks = new JSONArray();
                Map<Integer, String> typeById = new HashMap<>();
                Map<Integer, JSONArray> radioIdx = new HashMap<>();
                Map<Integer, JSONArray> radioOpts = new HashMap<>();

                for (JSONObject u : units) {
                    String type = u.optString("type");
                    int id = u.getInt("index");
                    String label = u.optString("label", "");
                    JSONObject ask = null;
                    if ("text".equals(type)) {
                        if (u.optString("current", "").trim().isEmpty()) {
                            ask = new JSONObject().put("index", id).put("type", "text")
                                    .put("label", label).put("multiline", u.optBoolean("multiline"));
                        }
                    } else if ("checkbox".equals(type)) {
                        if (!u.optBoolean("checked") && !label.isEmpty()) {
                            ask = new JSONObject().put("index", id).put("type", "checkbox").put("label", label);
                        }
                    } else if ("radio".equals(type)) {
                        if (!u.optBoolean("anyChecked")) {
                            ask = new JSONObject().put("index", id).put("type", "radio")
                                    .put("label", label).put("options", u.getJSONArray("options"));
                            radioIdx.put(id, u.getJSONArray("optIdx"));
                            radioOpts.put(id, u.getJSONArray("options"));
                        }
                    } else if ("dropdown".equals(type)) {
                        if (looksLikePlaceholder(u.optString("current", ""))) {
                            JSONArray opts = AureonAccessibilityService.readDropdownOptions(id);
                            if (opts.length() > 0) {
                                ask = new JSONObject().put("index", id).put("type", "dropdown")
                                        .put("label", label).put("options", opts);
                            } else {
                                String key = (label.isEmpty() ? "dropdown " + id : label).toLowerCase(Locale.ROOT);
                                if (skippedSeen.add(key)) skipped.put(label.isEmpty() ? "dropdown " + id : label);
                            }
                        }
                    }
                    if (ask != null) {
                        typeById.put(id, type);
                        asks.put(ask);
                    }
                }

                for (int start = 0; start < asks.length(); start += BATCH) {
                    JSONArray batch = new JSONArray();
                    for (int i = start; i < Math.min(asks.length(), start + BATCH); i++) batch.put(asks.get(i));
                    JSONObject resp = postFormFill(base, token, batch);

                    JSONArray answers = resp.optJSONArray("answers");
                    if (answers != null) {
                        for (int i = 0; i < answers.length(); i++) {
                            JSONObject a = answers.getJSONObject(i);
                            int id = a.getInt("index");
                            String value = a.optString("value", "");
                            String type = typeById.get(id);
                            if (type == null || value.isEmpty()) continue;
                            boolean ok = false;
                            if ("text".equals(type)) {
                                ok = AureonAccessibilityService.setTextAt(id, value);
                            } else if ("checkbox".equals(type)) {
                                if ("yes".equalsIgnoreCase(value)) ok = AureonAccessibilityService.setCheckedAt(id, true);
                            } else if ("radio".equals(type)) {
                                JSONArray opts = radioOpts.get(id);
                                JSONArray idxs = radioIdx.get(id);
                                if (opts != null && idxs != null) {
                                    for (int k = 0; k < opts.length(); k++) {
                                        if (opts.optString(k).equalsIgnoreCase(value)) {
                                            ok = AureonAccessibilityService.clickAt(idxs.getInt(k));
                                            break;
                                        }
                                    }
                                }
                            } else if ("dropdown".equals(type)) {
                                ok = AureonAccessibilityService.chooseDropdown(id, value);
                            }
                            if (ok) filled++;
                            sleep(200);
                        }
                    }
                    JSONArray sk = resp.optJSONArray("skipped");
                    if (sk != null) {
                        for (int i = 0; i < sk.length(); i++) {
                            JSONObject s = sk.getJSONObject(i);
                            String lbl = s.optString("label", "");
                            if (lbl.isEmpty()) lbl = "field " + s.optInt("index");
                            if (skippedSeen.add(lbl.toLowerCase(Locale.ROOT))) skipped.put(lbl);
                        }
                    }
                }

                if (!AureonAccessibilityService.scroll(true)) break;
                sleep(900);
            }

            return new JSONObject()
                    .put("filled", filled)
                    .put("skipped", skipped)
                    .put("screens", screens + 1)
                    .put("note", "Nothing was submitted. The user must review and tap Apply/Submit themselves.");
        } catch (JSONException e) {
            throw new AureonAgentActions.ActionException("Form fill failed: " + e.getMessage());
        }
    }

    private static JSONObject postFormFill(String base, String token, JSONArray fields)
            throws AureonAgentActions.ActionException, JSONException {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base + "/api/form-fill");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setDoOutput(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(90000); // free hosting can cold-start slowly
            byte[] body = new JSONObject().put("fields", fields).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) { os.write(body); }
            int code = conn.getResponseCode();
            InputStream is = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line);
                }
            }
            JSONObject json;
            try { json = new JSONObject(sb.toString()); } catch (JSONException je) { json = new JSONObject(); }
            if (code < 200 || code >= 300) {
                throw new AureonAgentActions.ActionException(json.optString("error", "Server returned " + code));
            }
            return json;
        } catch (java.io.IOException e) {
            throw new AureonAgentActions.ActionException("Backend se connect nahi hua: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
