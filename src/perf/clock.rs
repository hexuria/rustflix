//! Frame accounting from timestamps only (no clock reads, no platform
//! calls), so it is tested with synthetic ones.
//!
//! A **frame** is one drawable GPUI encoded: every window draw and every
//! present-only re-encode calls `-[CAMetalLayer nextDrawable]` once, on the
//! main thread, whichever view was dirty (the hook is in `present.rs`).
//!
//! - **cost**: the main thread's work in the run-loop wake-up that produced
//!   the frame, the drawable wait excluded: from the wake-up's start (or the
//!   previous frame's end in the same wake-up) to `nextDrawable` — the
//!   draw: layout, prepaint, NSH's paint, scene building, and whatever ran
//!   before it in that wake-up (input, a batch) — plus from `nextDrawable`'s
//!   return to the sleep (encoding, commit). A frame is *slow* when its cost
//!   alone is over one refresh.
//! - **wait**: the time `nextDrawable` blocked (all drawables in use: the
//!   display or the GPU is behind). Back-pressure, not work.
//! - **between**: wake-ups that produced no frame (batches applied, timers,
//!   input that drew nothing): their work, as stretches of their own; never
//!   charged to a frame. A stretch over one refresh is a *stall*.
//! - **late** ([`Presents`]): a frame that reached the glass more than 1.5
//!   refreshes after the previous one while frames were being produced
//!   continuously (the gap before it was at most two refreshes). Idle gaps
//!   are never late.

use std::time::{Duration, Instant};

/// A gap between presentations from this long is idleness.
pub(crate) const IDLE: Duration = Duration::from_millis(100);

/// One frame's main-thread side.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FrameWork {
    pub(crate) seq: u64,
    /// Its work began (the wake-up, or the previous frame's end).
    pub(crate) from: Instant,
    pub(crate) end: Instant,
    pub(crate) cost: Duration,
    pub(crate) wait: Duration,
}

/// A wake-up of the main thread that produced no frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Stretch {
    pub(crate) from: Instant,
    pub(crate) busy: Duration,
}

/// The main thread's wake-ups and drawables, turned into frames and
/// stretches.
#[derive(Debug, Default)]
pub(crate) struct WorkClock {
    wake: Option<Instant>,
    /// Where the next frame's work begins in this wake-up.
    from: Option<Instant>,
    /// A drawable taken in this wake-up: (seq, from, call, return).
    open: Option<(u64, Instant, Instant, Instant)>,
    /// Time the watchdog had the thread suspended (not the app's work).
    pub(crate) suspended: Duration,
}

impl WorkClock {
    pub(crate) fn woke(&mut self, now: Instant) {
        self.wake = Some(now);
        self.from = Some(now);
    }

    /// `nextDrawable` was called at `call` and returned at `ret`. A frame
    /// taken earlier in the same wake-up ends here (its encode is done).
    pub(crate) fn drawable(&mut self, seq: u64, call: Instant, ret: Instant) -> Option<FrameWork> {
        let done = self.open.take().map(|(s, from, c, r)| finish(s, from, c, r, r));
        let from = self.from.unwrap_or(call);
        self.open = Some((seq, from.min(call), call, ret));
        self.from = Some(ret);
        done
    }

    /// The run loop goes to sleep: the frame of this wake-up ends, or the
    /// wake-up was a stretch of other work.
    pub(crate) fn slept(&mut self, now: Instant) -> (Option<FrameWork>, Option<Stretch>) {
        let wake = self.wake.take();
        self.from = None;
        let suspended = std::mem::take(&mut self.suspended);
        if let Some((s, from, c, r)) = self.open.take() {
            let mut f = finish(s, from, c, r, now);
            f.cost = f.cost.saturating_sub(suspended);
            return (Some(f), None);
        }
        let stretch = wake.map(|w| Stretch {
            from: w,
            busy: now.saturating_duration_since(w).saturating_sub(suspended),
        });
        (None, stretch)
    }
}

fn finish(seq: u64, from: Instant, call: Instant, ret: Instant, end: Instant) -> FrameWork {
    FrameWork {
        seq,
        from,
        end,
        cost: call.saturating_duration_since(from) + end.saturating_duration_since(ret),
        wait: ret.saturating_duration_since(call),
    }
}

/// On-glass presentation times, in order, classified late or on time.
#[derive(Debug, Default)]
pub(crate) struct Presents {
    last: Option<f64>,
    last_gap: Option<f64>,
}

impl Presents {
    /// The frame reached the glass at `at` (seconds, any monotonic base);
    /// `period`: one refresh (seconds). Returns the refreshes it was late
    /// by (0: on time) and the gap since the previous presentation (`None`
    /// after idleness).
    pub(crate) fn presented(&mut self, at: f64, period: f64) -> (u32, Option<f64>) {
        let gap = self.last.map(|l| at - l).filter(|g| *g >= 0.0);
        self.last = Some(at);
        let Some(gap) = gap.filter(|g| *g < IDLE.as_secs_f64()) else {
            self.last_gap = None;
            return (0, None);
        };
        let active = self.last_gap.is_some_and(|g| g <= period * 2.0 + 1e-4);
        self.last_gap = Some(gap);
        if active && gap > period * 1.5 {
            (((gap / period).round() as u32).saturating_sub(1).max(1), Some(gap))
        } else {
            (0, Some(gap))
        }
    }
}

/// The last `cap` items, oldest first (a ring kept without reallocating).
#[derive(Debug)]
pub(crate) struct Ring<T> {
    items: std::collections::VecDeque<T>,
    cap: usize,
}

impl<T> Ring<T> {
    pub(crate) fn new(cap: usize) -> Ring<T> {
        Ring { items: std::collections::VecDeque::with_capacity(cap), cap }
    }

    pub(crate) fn push(&mut self, item: T) {
        if self.items.len() == self.cap {
            self.items.pop_front();
        }
        self.items.push_back(item);
    }

    pub(crate) fn iter(&self) -> impl DoubleEndedIterator<Item = &T> + ExactSizeIterator {
        self.items.iter()
    }

    pub(crate) fn iter_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut T> {
        self.items.iter_mut()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: f64) -> Duration {
        Duration::from_secs_f64(n / 1e3)
    }

    const P120: f64 = 1.0 / 120.0;
    const P60: f64 = 1.0 / 60.0;

    fn close(a: Duration, b: Duration) -> bool {
        a.abs_diff(b) < Duration::from_micros(2)
    }

    #[test]
    fn a_frame_is_its_wake_ups_work_without_the_drawable_wait() {
        let t0 = Instant::now();
        let mut c = WorkClock::default();
        c.woke(t0);
        // 3 ms of draw, 5 ms blocked in nextDrawable, 1 ms of encoding.
        assert!(c.drawable(1, t0 + ms(3.0), t0 + ms(8.0)).is_none());
        let (f, s) = c.slept(t0 + ms(9.0));
        let f = f.expect("a frame");
        assert!(s.is_none());
        assert!(close(f.cost, ms(4.0)));
        assert!(close(f.wait, ms(5.0)));
        assert_eq!(f.seq, 1);
    }

    #[test]
    fn a_wake_up_with_no_drawable_is_a_stretch_never_a_frame() {
        let t0 = Instant::now();
        let mut c = WorkClock::default();
        c.woke(t0);
        let (f, s) = c.slept(t0 + ms(40.0));
        assert!(f.is_none());
        assert!(close(s.expect("a stretch").busy, ms(40.0)));
        // Idle time between wake-ups is in nothing.
        c.woke(t0 + ms(2000.0));
        c.drawable(2, t0 + ms(2000.5), t0 + ms(2000.6));
        let (f, _) = c.slept(t0 + ms(2001.0));
        assert!(close(f.expect("a frame").cost, ms(0.9)));
    }

    #[test]
    fn two_frames_in_one_wake_up_split_it() {
        let t0 = Instant::now();
        let mut c = WorkClock::default();
        c.woke(t0);
        assert!(c.drawable(1, t0 + ms(2.0), t0 + ms(2.1)).is_none());
        let first = c.drawable(2, t0 + ms(4.0), t0 + ms(4.1)).expect("the first ends");
        assert!(close(first.cost, ms(2.0)));
        let (second, _) = c.slept(t0 + ms(5.0));
        // From the first's return to the second's call, then to the sleep.
        assert!(close(second.expect("the second").cost, ms(2.8)));
    }

    #[test]
    fn suspensions_by_the_watchdog_are_not_work() {
        let t0 = Instant::now();
        let mut c = WorkClock::default();
        c.woke(t0);
        c.drawable(1, t0 + ms(10.0), t0 + ms(10.0));
        c.suspended = ms(0.3);
        let (f, _) = c.slept(t0 + ms(10.0));
        assert!(close(f.unwrap().cost, ms(9.7)));
    }

    fn run(p: &mut Presents, times_ms: &[f64], period: f64) -> Vec<u32> {
        times_ms.iter().map(|t| p.presented(t / 1e3, period).0).collect()
    }

    #[test]
    fn steady_120_hz_is_never_late() {
        let mut p = Presents::default();
        let times: Vec<f64> = (0..240).map(|i| i as f64 * 8.333).collect();
        assert!(run(&mut p, &times, P120).iter().all(|l| *l == 0));
    }

    #[test]
    fn one_skipped_vsync_is_one_late_frame() {
        let mut p = Presents::default();
        let mut times: Vec<f64> = (0..10).map(|i| i as f64 * 8.333).collect();
        times.push(10.0 * 8.333 + 8.333); // the vsync at 10 was skipped
        times.extend((12..20).map(|i| i as f64 * 8.333));
        let late = run(&mut p, &times, P120);
        assert_eq!(late.iter().filter(|l| **l > 0).count(), 1);
        assert_eq!(late[10], 1);
    }

    #[test]
    fn the_first_frame_after_idle_is_not_late() {
        let mut p = Presents::default();
        // After idleness, the second frame 42 ms after the first: the run
        // has not started (no steady gap before it), so not late.
        let late = run(&mut p, &[0.0, 8.3, 16.7, 2000.0, 2041.7], P120);
        assert_eq!(late, [0, 0, 0, 0, 0]);
        // A second frame after idle, then a gap: the run had started.
        let late = run(&mut p, &[3000.0, 3008.3, 3016.7, 3050.0], P120);
        assert_eq!(late[3], 3);
    }

    #[test]
    fn a_50_ms_block_inside_a_run_is_late_by_five_refreshes() {
        let mut p = Presents::default();
        let mut times: Vec<f64> = (0..10).map(|i| i as f64 * 8.333).collect();
        let last = 9.0 * 8.333;
        times.push(last + 50.0);
        let late = run(&mut p, &times, P120);
        assert_eq!(late[10], 5, "50 ms is 6 refreshes: 5 missed");
    }

    #[test]
    fn steady_60_hz_content_on_a_60_hz_display_is_on_time() {
        let mut p = Presents::default();
        let times: Vec<f64> = (0..120).map(|i| i as f64 * 16.667).collect();
        assert!(run(&mut p, &times, P60).iter().all(|l| *l == 0));
    }

    #[test]
    fn present_only_frames_count_as_frames() {
        // Present-only re-encodes take a drawable like a draw: each is a
        // frame of the clock, with its own (small) cost.
        let t0 = Instant::now();
        let mut c = WorkClock::default();
        for i in 0..3 {
            let t = t0 + ms(i as f64 * 8.333);
            c.woke(t);
            c.drawable(i, t + ms(0.05), t + ms(0.06));
            let (f, _) = c.slept(t + ms(0.2));
            assert!(f.is_some());
        }
    }

    #[test]
    fn the_ring_keeps_the_last_items() {
        let mut r = Ring::new(3);
        for i in 0..5 {
            r.push(i);
        }
        assert_eq!(r.iter().copied().collect::<Vec<_>>(), [2, 3, 4]);
        assert_eq!(r.len(), 3);
    }
}
