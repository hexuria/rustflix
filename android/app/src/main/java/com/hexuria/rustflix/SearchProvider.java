package com.hexuria.rustflix;

import android.app.SearchManager;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.provider.BaseColumns;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * rustflix in the system's search (res/xml/searchable.xml): on Android TV /
 * Google TV the remote's microphone and the home screen's search ask every
 * "searchable app" for results and show them beside Google's own; picking one
 * opens the app on that title.
 *
 * <p>The system queries {@code content://com.hexuria.rustflix.search/
 * search_suggest_query} with the words (selection argument 0, or the last
 * path segment) on a binder thread; this asks TMDB (movies and series, the
 * app's own search) and answers the columns {@link SearchManager} names. The
 * TMDB key is the app's: the interface hands it over once it has one
 * ({@code sys.searchKey}), so nothing is found before the first launch.
 *
 * <p>A picked result comes to MainActivity as {@code ACTION_VIEW} with the
 * data {@code rustflix://title/<movie|tv>/<id>}; a spoken or typed query for
 * the app itself as {@code ACTION_SEARCH} with {@link SearchManager#QUERY}
 * ({@link #request}).
 */
public final class SearchProvider extends ContentProvider {
    static final String AUTHORITY = "com.hexuria.rustflix.search";
    private static final String PREFS = "search";
    private static final String KEY = "tmdbKey";
    private static final int TIMEOUT_MS = 4000;

    private static final String[] COLUMNS = {
        BaseColumns._ID,
        SearchManager.SUGGEST_COLUMN_TEXT_1,
        SearchManager.SUGGEST_COLUMN_TEXT_2,
        SearchManager.SUGGEST_COLUMN_RESULT_CARD_IMAGE,
        SearchManager.SUGGEST_COLUMN_CONTENT_TYPE,
        SearchManager.SUGGEST_COLUMN_PRODUCTION_YEAR,
        SearchManager.SUGGEST_COLUMN_DURATION,
        SearchManager.SUGGEST_COLUMN_RATING_STYLE,
        SearchManager.SUGGEST_COLUMN_RATING_SCORE,
        SearchManager.SUGGEST_COLUMN_INTENT_DATA_ID,
    };

    /** The interface's TMDB key (sys.searchKey); "" forgets it. */
    static void setKey(Context c, String key) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, key == null ? "" : key.trim()).apply();
    }

    /**
     * What an intent asks the interface to open: {@code {type, id}} for a
     * picked result, {@code {search}} for a query; null for any other intent.
     */
    static Map<String, Object> request(Intent in) {
        if (in == null) return null;
        Map<String, Object> m = new HashMap<>();
        Uri data = in.getData();
        if (Intent.ACTION_VIEW.equals(in.getAction()) && data != null && "rustflix".equals(data.getScheme())
                && "title".equals(data.getHost())) {
            java.util.List<String> p = data.getPathSegments();
            if (p.size() >= 2 && ("movie".equals(p.get(0)) || "tv".equals(p.get(0)))) {
                try {
                    m.put("type", p.get(0));
                    m.put("id", Long.parseLong(p.get(1)));
                    return m;
                } catch (NumberFormatException e) {
                    return null;
                }
            }
            return null;
        }
        if (Intent.ACTION_SEARCH.equals(in.getAction())) {
            String q = in.getStringExtra(SearchManager.QUERY);
            m.put("search", q == null ? "" : q.trim());
            return m;
        }
        return null;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        MatrixCursor out = new MatrixCursor(COLUMNS);
        String q = args != null && args.length > 0 && args[0] != null ? args[0] : null;
        if (q == null) {
            String last = uri.getLastPathSegment();
            if (last != null && !SearchManager.SUGGEST_URI_PATH_QUERY.equals(last)) q = last;
        }
        q = q == null ? "" : q.trim();
        Context c = getContext();
        if (q.isEmpty() || c == null) return out;
        String key = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "");
        if (key == null || key.isEmpty()) return out;
        int limit = 10;
        try {
            String l = uri.getQueryParameter(SearchManager.SUGGEST_PARAMETER_LIMIT);
            if (l != null) limit = Math.max(1, Math.min(20, Integer.parseInt(l)));
        } catch (RuntimeException e) {
            // keep the default
        }
        try {
            fill(out, search(q, key), limit);
            Log.i(MainActivity.TAG, "search provider: " + out.getCount() + " results for " + getCallingPackage());
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "search provider: " + e);
        }
        return out;
    }

    /** TMDB's multi search: movies and series (people are skipped). */
    private static JSONArray search(String q, String key) throws Exception {
        // Read access tokens are JWTs (v4); anything else is a v3 key (app/lib/tmdb.ts).
        boolean bearer = key.startsWith("eyJ") || key.length() > 60;
        String url = "https://api.themoviedb.org/3/search/multi?include_adult=false&language=en-US&page=1&query="
                + URLEncoder.encode(q, "UTF-8") + (bearer ? "" : "&api_key=" + URLEncoder.encode(key, "UTF-8"));
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setConnectTimeout(TIMEOUT_MS);
            h.setReadTimeout(TIMEOUT_MS);
            if (bearer) h.setRequestProperty("Authorization", "Bearer " + key);
            if (h.getResponseCode() != 200) throw new java.io.IOException("TMDB " + h.getResponseCode());
            try (InputStream in = h.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[8192];
                for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
                return new JSONObject(buf.toString("UTF-8")).optJSONArray("results");
            }
        } finally {
            h.disconnect();
        }
    }

    private static void fill(MatrixCursor out, JSONArray results, int limit) {
        if (results == null) return;
        for (int i = 0, n = 0; i < results.length() && n < limit; i++) {
            JSONObject r = results.optJSONObject(i);
            if (r == null) continue;
            String type = r.optString("media_type");
            boolean movie = "movie".equals(type);
            if (!movie && !"tv".equals(type)) continue;
            long id = r.optLong("id");
            String title = r.optString(movie ? "title" : "name");
            if (id <= 0 || title.isEmpty()) continue;
            String date = r.optString(movie ? "release_date" : "first_air_date");
            int year = 0;
            if (date.length() >= 4) {
                try {
                    year = Integer.parseInt(date.substring(0, 4));
                } catch (NumberFormatException e) {
                    // no year
                }
            }
            String poster = r.isNull("poster_path") ? "" : r.optString("poster_path");
            String overview = r.optString("overview");
            double vote = r.optDouble("vote_average", 0);
            out.addRow(new Object[] {
                (movie ? 1_000_000_000L : 2_000_000_000L) + id,
                title,
                overview.isEmpty() ? (movie ? "Movie" : "Series") : overview,
                poster.isEmpty() ? null : "https://image.tmdb.org/t/p/w342" + poster,
                "video/mp4",
                year,
                0,
                android.media.Rating.RATING_5_STARS,
                vote > 0 ? (float) (vote / 2) : null,
                type + "/" + id,
            });
            n++;
        }
    }

    @Override
    public String getType(Uri uri) {
        return SearchManager.SUGGEST_MIME_TYPE;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
}
