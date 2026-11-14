package com.hexuria.rustflix;

import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.text.Cue;
import androidx.media3.common.text.CueGroup;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.session.MediaSession;
import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@code rustflix.video}: the app's own video player on Android (contract:
 * scratchpad native/contract.md §1). Media3 ExoPlayer with HLS, rendering to
 * a {@link TextureView} so NSH views draw over it and it can be transformed
 * like any view; the app draws its own controls (no media3-ui).
 *
 * <ul>
 *   <li>Props: {@code src} (a new value replaces the item; the same value
 *       is a no-op; null stops and releases), {@code startAt} (applied once
 *       per src), {@code paused}, {@code muted}, {@code volume}, {@code rate}
 *       (pitch-corrected), {@code fit} ({@code contain | cover}, a transform
 *       on the TextureView), {@code maxResolution}; {@code frame} is ignored
 *       (phones: the component fills its box).
 *   <li>Commands: {@code seek {time}}, {@code selectAudio {id}},
 *       {@code selectSubtitle {id | null}} (embedded subtitles, drawn by a
 *       text view over the picture), {@code enterPip} / {@code exitPip}.
 *   <li>Events: ready {handle: null}, load, frame, tracks, progress (4 Hz
 *       while playing, and after seeks / pause / stall changes), buffer,
 *       seeked, rate, pip, end, error.
 * </ul>
 *
 * Audio focus and "becoming noisy" (headphones out → pause) are ExoPlayer's;
 * a {@link MediaSession} gives headset / Bluetooth / system media controls.
 * The screen stays on while it plays. The activity's stop pauses every
 * player (unless in picture-in-picture) and its start resumes those it
 * paused. A decoder failure retries once on H.264 / ≤ 1080p as a non-fatal
 * {@code error {code: "decode"}}; a second one is fatal.
 */
final class NativeVideo implements NshComponent {
    private static final String TAG = MainActivity.TAG;
    /** Live players, newest last (for PiP, the lifecycle and sys.nativePlayers). */
    private static final Set<NativeVideo> live = new LinkedHashSet<>();
    private static int seq;

    private final NshComponentContext ctx;
    private final Context context;
    private final FrameLayout root;
    private final TextureView texture;
    private final TextView captions;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ExoPlayer player;
    private MediaSession session;
    private DefaultTrackSelector selector;

    // Props.
    private String src;
    private double startAt;
    private boolean paused, muted;
    private float volume = 1f, rate = 1f;
    private boolean cover;
    private int maxW, maxH;

    // Per item.
    private long srcAt;
    private boolean loaded, framed, ended, decodeRetried, stalled, destroyed;
    private Double pendingSeek;
    private long seekAt;
    private float lastRate = -1;
    private long lastProgressAt;
    private boolean pausedByLifecycle;
    private boolean pipActive;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) progress(false);
            main.postDelayed(this, 250);
        }
    };

    NativeVideo(NshComponentContext ctx) {
        this.ctx = ctx;
        this.context = ctx.getContext();
        root = new FrameLayout(context);
        root.setBackgroundColor(Color.BLACK);
        root.setClipChildren(true);
        texture = new TextureView(context);
        root.addView(texture, new FrameLayout.LayoutParams(-1, -1));
        captions = new TextView(context);
        captions.setTextColor(Color.WHITE);
        captions.setShadowLayer(4, 0, 0, Color.BLACK);
        captions.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        captions.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        lp.bottomMargin = (int) (24 * context.getResources().getDisplayMetrics().density);
        root.addView(captions, lp);
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, orr, ob) -> applyFit());
        live.add(this);
        // Ready first, before anything else (contract §1.6). Phones need no
        // handle channel (§1.4).
        main.post(ticker);
    }

    static void register(NshView nsh) {
        nsh.registerComponent("rustflix.video", NativeVideo::new);
        // R1: the app's player exists here (turns it on in "auto" mode);
        // local: finished downloads play from the downloader's localhost
        // server (R3); fullscreen: by window (sys.playerWindow).
        nsh.handle("sys.nativeVideoInfo", (d, r) -> {
            Map<String, Object> m = new HashMap<>();
            m.put("ok", true);
            m.put("available", true);
            m.put("version", 1);
            Activity a = Pip.activity();
            m.put("pip", a != null && Pip.supported(a));
            m.put("fullscreen", true);
            m.put("local", true);
            r.resolve(m);
        });
        // Diagnostics the desktop also answers (contract §1.6).
        nsh.handle("sys.nativePlayers", (d, r) -> {
            int playing = 0;
            for (NativeVideo v : live) if (v.player != null && v.player.isPlaying()) playing++;
            Map<String, Object> m = new HashMap<>();
            m.put("live", live.size());
            m.put("playing", playing);
            r.resolve(m);
        });
    }

    @Override
    public View view() {
        return root;
    }

    // --- Props -----------------------------------------------------------------------

    private boolean readySent;

    /** `ready` (contract §1.4–1.6): once, first, as soon as the element's
     * handlers are bound — NSH binds them with the first batch of props,
     * which follows the factory, so it goes out right after that batch. */
    private void sendReady() {
        if (readySent) return;
        readySent = true;
        main.post(() -> {
            Map<String, Object> ready = new HashMap<>();
            ready.put("handle", null);
            emit("ready", ready);
        });
    }

    @Override
    public void setProp(String name, Object value) {
        sendReady();
        switch (name) {
            case "src":
                setSrc(value instanceof String && !((String) value).isEmpty() ? (String) value : null);
                break;
            case "startAt":
                startAt = value instanceof Number ? Math.max(0, ((Number) value).doubleValue()) : 0;
                break;
            case "paused":
                paused = Boolean.TRUE.equals(value);
                pausedByLifecycle = false;
                if (player != null) player.setPlayWhenReady(!paused);
                progress(true);
                break;
            case "muted":
                muted = Boolean.TRUE.equals(value);
                applyVolume();
                break;
            case "volume":
                volume = value instanceof Number ? clamp(((Number) value).floatValue(), 0, 1) : 1f;
                applyVolume();
                break;
            case "rate":
                rate = value instanceof Number ? clamp(((Number) value).floatValue(), 0.25f, 4f) : 1f;
                if (player != null) player.setPlaybackParameters(new PlaybackParameters(rate));
                break;
            case "fit":
                cover = "cover".equals(value);
                applyFit();
                break;
            case "maxResolution":
                maxW = maxH = 0;
                if (value instanceof Map) {
                    Object w = ((Map<?, ?>) value).get("width"), h = ((Map<?, ?>) value).get("height");
                    if (w instanceof Number && h instanceof Number) {
                        maxW = ((Number) w).intValue();
                        maxH = ((Number) h).intValue();
                    }
                }
                applyMaxResolution();
                break;
            default:
                break; // frame (desktop only) and anything newer
        }
    }

    private static float clamp(float v, float lo, float hi) {
        return Float.isNaN(v) ? lo : Math.max(lo, Math.min(hi, v));
    }

    private void applyVolume() {
        if (player != null) player.setVolume(muted ? 0f : volume);
    }

    private void applyMaxResolution() {
        if (player == null) return;
        TrackSelectionParameters.Builder b = player.getTrackSelectionParameters().buildUpon();
        if (maxW > 0 && maxH > 0) b.setMaxVideoSize(maxW, maxH);
        else b.clearVideoSizeConstraints();
        player.setTrackSelectionParameters(b.build());
    }

    private void setSrc(String url) {
        if (url == null ? src == null : url.equals(src)) return;
        src = url;
        releasePlayer();
        if (url == null) return;
        srcAt = SystemClock.elapsedRealtime();
        // The rest of this batch of props (startAt, paused, muted…) comes
        // right after: load once they are all in.
        main.post(() -> {
            if (!destroyed && url.equals(src) && player == null) load(url);
        });
    }

    /**
     * A finished download's page from the downloader's localhost server
     * ({@code …/<token>/<id>/player.html?f=<file>}, what {@code dl.playUrl}
     * answers) plays its media file ({@code …/<token>/<id>/<file>}) — Media3
     * reads the fMP4 HLS WebView could not. Anything else as given.
     */
    static String mediaUrl(String url) {
        android.net.Uri u = android.net.Uri.parse(url);
        String path = u.getPath(), f = u.getQueryParameter("f");
        if ("127.0.0.1".equals(u.getHost()) && path != null && path.endsWith("/player.html") && f != null
                && !f.isEmpty() && !f.contains("/") && !f.startsWith(".")) {
            return u.buildUpon().clearQuery()
                    .path(path.substring(0, path.length() - "player.html".length()) + f)
                    .build().toString();
        }
        return url;
    }

    private void load(String url) {
        url = mediaUrl(url);
        loaded = framed = ended = decodeRetried = stalled = false;
        pendingSeek = null;
        lastRate = -1;
        selector = new DefaultTrackSelector(context);
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(context).setEnableDecoderFallback(true);
        player = new ExoPlayer.Builder(context, renderers).setTrackSelector(selector).build();
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setVideoTextureView(texture);
        player.addListener(listener);
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
        applyMaxResolution();
        applyVolume();
        player.setPlaybackParameters(new PlaybackParameters(rate));
        MediaItem.Builder item = new MediaItem.Builder().setUri(url);
        if (url.toLowerCase(java.util.Locale.ROOT).contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        player.setMediaItem(item.build(), (long) (startAt * 1000));
        player.setPlayWhenReady(!paused && !pausedByLifecycle);
        player.prepare();
        try {
            session = new MediaSession.Builder(context, player).setId("rustflix-video-" + (++seq)).build();
        } catch (RuntimeException e) {
            Log.w(TAG, "video: no media session: " + e);
        }
    }

    private void releasePlayer() {
        if (session != null) {
            session.release();
            session = null;
        }
        if (player != null) {
            player.removeListener(listener);
            player.stop();
            player.clearVideoTextureView(texture);
            player.release();
            player = null;
        }
        captions.setText("");
        root.setKeepScreenOn(false);
    }

    // --- Commands ----------------------------------------------------------------------

    @Override
    public void command(String name, Object args) {
        Map<?, ?> a = args instanceof Map ? (Map<?, ?>) args : Collections.emptyMap();
        switch (name) {
            case "seek":
                if (a.get("time") instanceof Number) seek(((Number) a.get("time")).doubleValue());
                break;
            case "selectAudio":
                select(C.TRACK_TYPE_AUDIO, a.get("id") == null ? null : String.valueOf(a.get("id")));
                break;
            case "selectSubtitle":
                select(C.TRACK_TYPE_TEXT, a.get("id") == null ? null : String.valueOf(a.get("id")));
                break;
            case "enterPip":
                if (!Pip.enterFor(this)) pipEvent();
                break;
            case "exitPip":
                pipEvent(); // the user leaves PiP by expanding its window
                break;
            default:
                break;
        }
    }

    void seek(double time) {
        if (player == null) return;
        if (pendingSeek != null) seeked(false); // superseded
        pendingSeek = Math.max(0, time);
        seekAt = SystemClock.elapsedRealtime();
        player.seekTo((long) (pendingSeek * 1000));
        progress(true);
    }

    private void seeked(boolean finished) {
        if (pendingSeek == null) return;
        Map<String, Object> m = new HashMap<>();
        m.put("target", pendingSeek);
        m.put("time", player == null ? null : player.getCurrentPosition() / 1000.0);
        m.put("finished", finished);
        m.put("ms", SystemClock.elapsedRealtime() - seekAt);
        pendingSeek = null;
        emit("seeked", m);
    }

    /** Selects track {@code id} ("a0", "s1"…) of {@code type}; null: subtitles off. */
    private void select(int type, String id) {
        if (player == null) return;
        TrackSelectionParameters.Builder b = player.getTrackSelectionParameters().buildUpon();
        if (id == null) {
            if (type == C.TRACK_TYPE_TEXT) {
                player.setTrackSelectionParameters(b.clearOverridesOfType(C.TRACK_TYPE_TEXT)
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
                captions.setText("");
            }
            return;
        }
        char prefix = type == C.TRACK_TYPE_AUDIO ? 'a' : 's';
        int n = 0;
        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != type) continue;
            for (int i = 0; i < g.length; i++, n++) {
                if (id.equals(prefix + String.valueOf(n))) {
                    player.setTrackSelectionParameters(b.setTrackTypeDisabled(type, false)
                            .setOverrideForType(new TrackSelectionOverride(g.getMediaTrackGroup(), i)).build());
                    return;
                }
            }
        }
        Map<String, Object> e = new HashMap<>();
        e.put("message", "no " + (type == C.TRACK_TYPE_AUDIO ? "audio" : "subtitle") + " track " + id);
        e.put("code", "track");
        e.put("fatal", false);
        emit("error", e);
    }

    // --- Events ------------------------------------------------------------------------

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY && !loaded) {
                loaded = true;
                emitLoad();
                pipEvent();
            }
            if (state == Player.STATE_READY && pendingSeek != null) seeked(true);
            if (state == Player.STATE_ENDED && !ended) {
                ended = true;
                progress(true);
                emit("end", new HashMap<>());
            }
            updateStall();
            updateRate();
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            updateStall();
            updateRate();
            progress(true);
        }

        @Override
        public void onIsPlayingChanged(boolean playing) {
            root.setKeepScreenOn(playing);
            updateRate();
            Pip.nativeStateChanged();
        }

        @Override
        public void onPlaybackParametersChanged(@NonNull PlaybackParameters p) {
            updateRate();
        }

        @Override
        public void onRenderedFirstFrame() {
            if (framed) return;
            framed = true;
            VideoSize s = player == null ? VideoSize.UNKNOWN : player.getVideoSize();
            Map<String, Object> m = new HashMap<>();
            m.put("ms", SystemClock.elapsedRealtime() - srcAt);
            m.put("width", s.width);
            m.put("height", s.height);
            emit("frame", m);
        }

        @Override
        public void onVideoSizeChanged(@NonNull VideoSize size) {
            applyFit();
            Pip.nativeStateChanged();
        }

        @Override
        public void onTracksChanged(@NonNull Tracks tracks) {
            if (!loaded) return;
            Map<String, Object> m = new HashMap<>();
            m.put("audioTracks", trackList(C.TRACK_TYPE_AUDIO));
            m.put("subtitleTracks", trackList(C.TRACK_TYPE_TEXT));
            emit("tracks", m);
        }

        @Override
        public void onCues(@NonNull CueGroup cues) {
            StringBuilder b = new StringBuilder();
            for (Cue c : cues.cues) {
                if (c.text == null) continue;
                if (b.length() > 0) b.append('\n');
                b.append(c.text);
            }
            captions.setText(b);
        }

        @Override
        public void onPositionDiscontinuity(@NonNull Player.PositionInfo o, @NonNull Player.PositionInfo n, int reason) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK && player != null
                    && player.getPlaybackState() == Player.STATE_READY && pendingSeek != null) {
                seeked(true);
            }
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            onError(error);
        }
    };

    private void emitLoad() {
        Map<String, Object> m = new HashMap<>();
        long d = player.getDuration();
        m.put("duration", d == C.TIME_UNSET || player.isCurrentMediaItemLive() ? null : d / 1000.0);
        VideoSize s = player.getVideoSize();
        m.put("width", s.width);
        m.put("height", s.height);
        m.put("audioTracks", trackList(C.TRACK_TYPE_AUDIO));
        m.put("subtitleTracks", trackList(C.TRACK_TYPE_TEXT));
        m.put("ms", SystemClock.elapsedRealtime() - srcAt);
        emit("load", m);
    }

    private List<Map<String, Object>> trackList(int type) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (player == null) return out;
        char prefix = type == C.TRACK_TYPE_AUDIO ? 'a' : 's';
        int n = 0;
        for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
            if (g.getType() != type) continue;
            for (int i = 0; i < g.length; i++, n++) {
                Format f = g.getTrackFormat(i);
                Map<String, Object> t = new HashMap<>();
                t.put("id", prefix + String.valueOf(n));
                String lang = f.language == null || "und".equals(f.language) ? null : f.language;
                String label = f.label != null ? f.label
                        : lang != null ? new java.util.Locale(lang).getDisplayLanguage()
                        : (type == C.TRACK_TYPE_AUDIO ? "Audio " : "Subtitles ") + (n + 1);
                t.put("label", label);
                t.put("lang", lang);
                t.put("default", (f.selectionFlags & C.SELECTION_FLAG_DEFAULT) != 0);
                t.put("selected", g.isTrackSelected(i));
                out.add(t);
            }
        }
        return out;
    }

    private void updateStall() {
        boolean now = player != null && player.getPlayWhenReady() && player.getPlaybackState() == Player.STATE_BUFFERING;
        if (now == stalled) return;
        stalled = now;
        Map<String, Object> m = new HashMap<>();
        m.put("stalled", now);
        m.put("reason", now ? (pendingSeek != null ? "seeking" : "buffering") : null);
        emit("buffer", m);
        progress(true);
    }

    private void updateRate() {
        float r = player != null && player.isPlaying() ? player.getPlaybackParameters().speed : 0f;
        if (r == lastRate) return;
        lastRate = r;
        Map<String, Object> m = new HashMap<>();
        m.put("rate", (double) r);
        emit("rate", m);
    }

    /** progress: every 250 ms while playing (the ticker), and once on demand. */
    private void progress(boolean once) {
        if (player == null || (!loaded && !framed)) return;
        long now = SystemClock.elapsedRealtime();
        if (!once && now - lastProgressAt < 200) return;
        lastProgressAt = now;
        Map<String, Object> m = new HashMap<>();
        m.put("currentTime", player.getCurrentPosition() / 1000.0);
        double buffered = player.getBufferedPosition() / 1000.0;
        m.put("buffered", buffered);
        m.put("playable", buffered);
        emit("progress", m);
    }

    private void onError(PlaybackException e) {
        int code = e.errorCode;
        boolean decode = code == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED
                || code == PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED
                || code == PlaybackException.ERROR_CODE_DECODING_FAILED
                || code == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES
                || code == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED;
        Map<String, Object> m = new HashMap<>();
        m.put("message", e.getErrorCodeName() + ": " + (e.getCause() != null ? e.getCause().getMessage() : e.getMessage()));
        m.put("code", codeOf(e));
        if (decode && !decodeRetried && player != null) {
            // Another variant may decode: H.264, at most 1080p, from where it was.
            decodeRetried = true;
            m.put("fatal", false);
            emit("error", m);
            long at = player.getCurrentPosition();
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setPreferredVideoMimeType(MimeTypes.VIDEO_H264)
                    .setMaxVideoSize(1920, 1080)
                    .build());
            player.seekTo(at);
            player.prepare();
            return;
        }
        m.put("fatal", true);
        Log.w(TAG, "video: " + m.get("message"));
        emit("error", m);
    }

    private static String codeOf(PlaybackException e) {
        int c = e.errorCode;
        if (c == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) {
            Throwable t = e.getCause();
            if (t instanceof HttpDataSource.InvalidResponseCodeException) {
                return "http" + ((HttpDataSource.InvalidResponseCodeException) t).responseCode;
            }
            return "network";
        }
        if (c >= 2000 && c < 3000) return "network"; // IO_*
        if (c >= 3000 && c < 4000) return "format"; // PARSING_*
        if (c >= 4000 && c < 5000) return "decode"; // DECODING_* / DECODER_*
        if (c >= 6000 && c < 7000) return "source"; // DRM_*
        return "internal";
    }

    void pipEvent() {
        Activity a = activity();
        Map<String, Object> m = new HashMap<>();
        m.put("active", pipActive);
        m.put("possible", a != null && Pip.supported(a));
        emit("pip", m);
    }

    private void emit(String name, Object data) {
        if (destroyed) return;
        ctx.emit(name, data);
    }

    // --- Fit -------------------------------------------------------------------------

    /** Letterbox (contain) or fill-and-crop (cover) inside the view. */
    private void applyFit() {
        int vw = texture.getWidth(), vh = texture.getHeight();
        if (player == null || vw == 0 || vh == 0) return;
        VideoSize s = player.getVideoSize();
        if (s.width == 0 || s.height == 0) return;
        float videoW = s.width * s.pixelWidthHeightRatio, videoH = s.height;
        float scale = cover ? Math.max(vw / videoW, vh / videoH) : Math.min(vw / videoW, vh / videoH);
        Matrix m = new Matrix();
        m.setScale(videoW * scale / vw, videoH * scale / vh, vw / 2f, vh / 2f);
        texture.setTransform(m);
        texture.invalidate();
    }

    // --- PiP, lifecycle --------------------------------------------------------------------

    Activity activity() {
        Context c = context;
        while (c instanceof ContextWrapper) {
            if (c instanceof Activity) return (Activity) c;
            c = ((ContextWrapper) c).getBaseContext();
        }
        return null;
    }

    /** The newest player showing a picture (PiP follows it), or null. */
    static NativeVideo current() {
        NativeVideo found = null;
        for (NativeVideo v : live) if (v.player != null && v.root.isAttachedToWindow()) found = v;
        return found;
    }

    boolean isPlaying() {
        return player != null && player.isPlaying();
    }

    View pictureView() {
        return root;
    }

    /** The video's size in pixels (0 × 0 unknown). */
    int[] videoSize() {
        if (player == null) return new int[] {0, 0};
        VideoSize s = player.getVideoSize();
        return new int[] {(int) (s.width * s.pixelWidthHeightRatio), s.height};
    }

    Rect screenRect() {
        Rect r = new Rect();
        return root.getGlobalVisibleRect(r) && !r.isEmpty() ? r : null;
    }

    /** PiP remote actions: "toggle", "back", "fwd", "pause". */
    void remote(String a) {
        if (player == null) return;
        switch (a) {
            case "toggle":
                player.setPlayWhenReady(!player.getPlayWhenReady());
                break;
            case "pause":
                player.setPlayWhenReady(false);
                break;
            case "back":
                seek(Math.max(0, player.getCurrentPosition() / 1000.0 - 10));
                break;
            case "fwd":
                seek(player.getCurrentPosition() / 1000.0 + 10);
                break;
            default:
                break;
        }
    }

    static void pipChanged(boolean active) {
        NativeVideo shown = current();
        for (NativeVideo v : new ArrayList<>(live)) {
            v.pipActive = active;
            v.fillWindow(active && v == shown);
            if (v.loaded) v.pipEvent();
        }
    }

    private View.OnLayoutChangeListener filler;

    /** In PiP the picture fills the PiP window, wherever the app laid the
     * component out (its box may be a part of the screen): a transform,
     * kept up to date as the window settles; undone on expand. */
    private void fillWindow(boolean on) {
        View top = root.getRootView();
        if (filler != null) {
            top.removeOnLayoutChangeListener(filler);
            filler = null;
        }
        if (!on) {
            root.setPivotX(0);
            root.setPivotY(0);
            root.setScaleX(1);
            root.setScaleY(1);
            root.setTranslationX(0);
            root.setTranslationY(0);
            return;
        }
        filler = (v, l, t, r, b, ol, ot, orr, ob) -> placeInWindow();
        top.addOnLayoutChangeListener(filler);
        root.post(this::placeInWindow);
    }

    private void placeInWindow() {
        View top = root.getRootView();
        int ww = top.getWidth(), wh = top.getHeight(), w = root.getWidth(), h = root.getHeight();
        if (ww == 0 || wh == 0 || w == 0 || h == 0) return;
        root.setTranslationX(0);
        root.setTranslationY(0);
        root.setScaleX(1);
        root.setScaleY(1);
        int[] at = new int[2];
        root.getLocationInWindow(at);
        float scale = Math.min(ww / (float) w, wh / (float) h);
        root.setPivotX(0);
        root.setPivotY(0);
        root.setScaleX(scale);
        root.setScaleY(scale);
        root.setTranslationX(-at[0] + (ww - w * scale) / 2f);
        root.setTranslationY(-at[1] + (wh - h * scale) / 2f);
    }

    /** The activity stopped: pause (unless the picture is in PiP). */
    static void onActivityStop(Activity a) {
        if (a.isInPictureInPictureMode()) return;
        for (NativeVideo v : live) {
            if (v.player != null && v.player.getPlayWhenReady()) {
                v.pausedByLifecycle = true;
                v.player.setPlayWhenReady(false);
            }
        }
    }

    /** The activity is back: resume what the stop paused. */
    static void onActivityStart() {
        for (NativeVideo v : live) {
            if (v.pausedByLifecycle) {
                v.pausedByLifecycle = false;
                if (v.player != null && !v.paused) v.player.setPlayWhenReady(true);
            }
        }
    }

    @Override
    public void destroy() {
        // Silence at once; no event after this (contract §1.6).
        destroyed = true;
        main.removeCallbacks(ticker);
        releasePlayer();
        live.remove(this);
        Pip.nativeStateChanged();
    }
}
