package com.aureon.ai;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Site logins for Aureon's auto-apply. Stored ONLY on this phone, encrypted
 * with an AES-256-GCM key that lives in the Android Keystore (the key can't
 * be exported). Passwords never go to the backend, Firebase, or any AI, and
 * are never handed back to the web layer — only host + username are listed.
 */
public final class AureonCredStore {
    private AureonCredStore() {}

    private static final String PREFS = "aureon_site_logins";
    private static final String ALIAS = "aureon_site_login_key";

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String normalizeHost(String raw) {
        String h = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        h = h.replaceFirst("^https?://", "");
        int slash = h.indexOf('/');
        if (slash >= 0) h = h.substring(0, slash);
        if (h.startsWith("www.")) h = h.substring(4);
        return h;
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return kg.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }

    private static String encrypt(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    }

    private static String decrypt(String stored) throws Exception {
        String[] p = stored.split(":");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p[0], Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(p[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    public static boolean save(Context ctx, String host, String user, String pass) {
        if (Build.VERSION.SDK_INT < 23) return false;
        String h = normalizeHost(host);
        if (h.isEmpty() || user == null || user.isEmpty() || pass == null || pass.isEmpty()) return false;
        try {
            String blob = encrypt(new JSONObject().put("u", user).put("p", pass).toString());
            prefs(ctx).edit().putString(h, blob).apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean delete(Context ctx, String host) {
        prefs(ctx).edit().remove(normalizeHost(host)).apply();
        return true;
    }

    /** {username, password} for the saved login that matches this host, or null. */
    public static String[] get(Context ctx, String host) {
        if (Build.VERSION.SDK_INT < 23) return null;
        String want = normalizeHost(host);
        if (want.isEmpty()) return null;
        try {
            for (Map.Entry<String, ?> e : prefs(ctx).getAll().entrySet()) {
                String h = e.getKey();
                if (want.equals(h) || want.endsWith("." + h)) {
                    JSONObject o = new JSONObject(decrypt((String) e.getValue()));
                    return new String[]{o.getString("u"), o.getString("p")};
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /** [{host, user}] — never includes passwords. */
    public static JSONArray list(Context ctx) {
        JSONArray out = new JSONArray();
        if (Build.VERSION.SDK_INT < 23) return out;
        try {
            for (Map.Entry<String, ?> e : prefs(ctx).getAll().entrySet()) {
                try {
                    JSONObject o = new JSONObject(decrypt((String) e.getValue()));
                    out.put(new JSONObject().put("host", e.getKey()).put("user", o.getString("u")));
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
        return out;
    }
}
