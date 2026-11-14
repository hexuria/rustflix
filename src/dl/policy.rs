//! Retry and expiry rules of the downloader — the same as the iPhone's
//! (`DlRetryPolicy` / `DlExpiryTracker` in `ios/Rustflix/HlsDownloader.swift`).

use std::{collections::HashMap, collections::HashSet, time::Duration};

/// Why one request failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// 401 / 403 / 410: the signed link may have expired.
    Auth(u16),
    /// Other 4xx (except 408 / 429).
    Client(u16),
    /// 5xx, 408, 429, or an HTML error page instead of media.
    Server,
    /// Connectivity: DNS, connect, reset, timeout.
    Network,
    /// Anything else (a local write failed, a malformed answer).
    Other,
}

pub(crate) fn is_auth_status(code: u16) -> bool {
    code == 401 || code == 403 || code == 410
}

/// The failure an HTTP status (not 2xx) stands for.
pub(crate) fn classify_status(code: u16) -> Failure {
    if is_auth_status(code) {
        Failure::Auth(code)
    } else if code == 408 || code == 429 || code >= 500 {
        Failure::Server
    } else if (400..500).contains(&code) {
        Failure::Client(code)
    } else {
        Failure::Other
    }
}

/// Attempts allowed per resource before the download fails.
pub(crate) fn limit(f: Failure) -> u32 {
    match f {
        Failure::Network => 30,
        Failure::Server => 10,
        Failure::Auth(_) | Failure::Client(_) => 3,
        Failure::Other => 6,
    }
}

/// Delay before attempt `attempt` (1-based) of a failed resource.
pub(crate) fn backoff(attempt: u32, f: Failure) -> Duration {
    let cap = if f == Failure::Network { 60.0 } else { 20.0 };
    let exp = attempt.saturating_sub(1).min(8) as i32;
    Duration::from_secs_f64((0.5 * 2f64.powi(exp)).min(cap))
}

const EXPIRY_KEYS: [&str; 8] = ["expires", "expire", "exp", "expiry", "e", "validto", "valid_to", "deadline"];

/// True when `url` carries an expiry timestamp (`Expires=`, `exp=`, `e=`,
/// … in seconds or milliseconds, also Akamai's `exp=…~acl=`) that is
/// before `now_secs`.
pub(crate) fn url_expired(url: &str, now_secs: f64) -> bool {
    let b = url.as_bytes();
    let lower = url.to_ascii_lowercase();
    let lb = lower.as_bytes();
    for start in 0..b.len() {
        // At the start, or right after a separator.
        if start > 0 && !b"?&/~;,=".contains(&b[start - 1]) {
            continue;
        }
        for key in EXPIRY_KEYS {
            let k = key.as_bytes();
            if !lb[start..].starts_with(k) || lb.get(start + k.len()) != Some(&b'=') {
                continue;
            }
            let digits_at = start + k.len() + 1;
            let n = b[digits_at..].iter().take_while(|c| c.is_ascii_digit()).count();
            let end = digits_at + n;
            let bounded = end == b.len() || b"&/~;,#".contains(&b[end]);
            if (n == 10 || n == 13) && bounded {
                let v: f64 = url[digits_at..end].parse().unwrap_or(f64::MAX);
                let secs = if v > 1e12 { v / 1000.0 } else { v };
                if secs < now_secs {
                    return true;
                }
            }
        }
    }
    false
}

/// Decides when auth failures mean "the signed link expired" rather than a
/// transient CDN 403: a 410, an expiry timestamp in the past, the same
/// resource refused 3 times, or 6 different resources refused with no
/// success in between.
#[derive(Default, Debug)]
pub(crate) struct ExpiryTracker {
    streak: HashSet<usize>,
    per_resource: HashMap<usize, u32>,
}

impl ExpiryTracker {
    pub(crate) const DISTINCT: usize = 6;
    pub(crate) const PER_RESOURCE: u32 = 3;

    pub(crate) fn success(&mut self, idx: usize) {
        self.streak.clear();
        self.per_resource.remove(&idx);
    }

    /// True when the record should be marked `expired`.
    pub(crate) fn auth_failure(&mut self, idx: usize, status: u16, url: &str, now_secs: f64) -> bool {
        let n = self.per_resource.entry(idx).or_insert(0);
        *n += 1;
        let n = *n;
        self.streak.insert(idx);
        status == 410
            || url_expired(url, now_secs)
            || n >= Self::PER_RESOURCE
            || self.streak.len() >= Self::DISTINCT
    }
}

/// Attempts and next-attempt times per resource, with the expiry tracker:
/// what one download remembers about its failures.
#[derive(Default, Debug)]
pub(crate) struct Retries {
    attempts: HashMap<usize, u32>,
    pub(crate) expiry: ExpiryTracker,
}

/// What to do after a failure.
#[derive(Debug, PartialEq)]
pub(crate) enum Verdict {
    /// Try again after this long.
    Retry(Duration),
    /// The link expired: fetch a fresh one.
    Expired,
    /// Out of attempts.
    Failed,
}

impl Retries {
    pub(crate) fn success(&mut self, idx: usize) {
        self.attempts.remove(&idx);
        self.expiry.success(idx);
    }

    pub(crate) fn failure(&mut self, idx: usize, url: &str, f: Failure, now_secs: f64) -> Verdict {
        let a = self.attempts.entry(idx).or_insert(0);
        *a += 1;
        let a = *a;
        if let Failure::Auth(code) = f
            && self.expiry.auth_failure(idx, code, url, now_secs)
        {
            return Verdict::Expired;
        }
        if a >= limit(f) {
            return Verdict::Failed;
        }
        Verdict::Retry(backoff(a, f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_700_000_000.0;

    #[test]
    fn expiry_timestamps_in_urls() {
        assert!(url_expired("https://c/x.m3u8?Expires=1600000000&sig=a", NOW));
        assert!(!url_expired("https://c/x.m3u8?Expires=1800000000&sig=a", NOW));
        assert!(url_expired("https://c/x.m3u8?e=1600000000000", NOW)); // ms
        assert!(url_expired("https://c/hdntl=exp=1600000000~acl=/*~hmac=ab/x.ts", NOW));
        assert!(url_expired("https://c/x.ts?a=1&EXP=1600000000#t", NOW));
        // Not a key at a boundary, wrong digit counts, not bounded.
        assert!(!url_expired("https://c/x.ts?type=1600000000", NOW));
        assert!(!url_expired("https://c/x.ts?exp=160000000", NOW));
        assert!(!url_expired("https://c/x.ts?exp=16000000001", NOW));
        assert!(!url_expired("https://c/x.ts?exp=1600000000x", NOW));
        assert!(!url_expired("https://c/x.ts", NOW));
    }

    #[test]
    fn retry_policy_limits_and_backoff() {
        assert_eq!(classify_status(403), Failure::Auth(403));
        assert_eq!(classify_status(404), Failure::Client(404));
        assert_eq!(classify_status(429), Failure::Server);
        assert_eq!(classify_status(408), Failure::Server);
        assert_eq!(classify_status(503), Failure::Server);
        assert_eq!(limit(Failure::Server), 10);
        assert_eq!(limit(Failure::Client(404)), 3);
        assert_eq!(limit(Failure::Network), 30);
        assert_eq!(backoff(1, Failure::Server), Duration::from_millis(500));
        assert_eq!(backoff(3, Failure::Server), Duration::from_secs(2));
        assert_eq!(backoff(9, Failure::Server), Duration::from_secs(20));
        assert_eq!(backoff(9, Failure::Network), Duration::from_secs(60));

        let mut r = Retries::default();
        for _ in 0..9 {
            assert!(matches!(r.failure(0, "u", Failure::Server, NOW), Verdict::Retry(_)));
        }
        assert_eq!(r.failure(0, "u", Failure::Server, NOW), Verdict::Failed);
        let mut r = Retries::default();
        r.failure(1, "u", Failure::Client(404), NOW);
        r.failure(1, "u", Failure::Client(404), NOW);
        assert_eq!(r.failure(1, "u", Failure::Client(404), NOW), Verdict::Failed);
        let mut r = Retries::default();
        for _ in 0..29 {
            assert!(matches!(r.failure(2, "u", Failure::Network, NOW), Verdict::Retry(_)));
        }
        assert_eq!(r.failure(2, "u", Failure::Network, NOW), Verdict::Failed);
    }

    #[test]
    fn expiry_rules() {
        // A 410 at once.
        let mut r = Retries::default();
        assert_eq!(r.failure(0, "u", Failure::Auth(410), NOW), Verdict::Expired);
        // An expired timestamp at once.
        let mut r = Retries::default();
        assert_eq!(r.failure(0, "https://c/a?exp=1600000000", Failure::Auth(403), NOW), Verdict::Expired);
        // The same segment refused three times.
        let mut r = Retries::default();
        assert!(matches!(r.failure(4, "u", Failure::Auth(403), NOW), Verdict::Retry(_)));
        assert!(matches!(r.failure(4, "u", Failure::Auth(403), NOW), Verdict::Retry(_)));
        assert_eq!(r.failure(4, "u", Failure::Auth(403), NOW), Verdict::Expired);
        // Six different segments with no success in between.
        let mut r = Retries::default();
        for i in 0..5 {
            assert!(matches!(r.failure(i, "u", Failure::Auth(403), NOW), Verdict::Retry(_)));
        }
        assert_eq!(r.failure(5, "u", Failure::Auth(403), NOW), Verdict::Expired);
        // ... but a success in between resets the streak.
        let mut r = Retries::default();
        for i in 0..5 {
            r.failure(i, "u", Failure::Auth(403), NOW);
        }
        r.success(9);
        assert!(matches!(r.failure(5, "u", Failure::Auth(403), NOW), Verdict::Retry(_)));
    }
}
