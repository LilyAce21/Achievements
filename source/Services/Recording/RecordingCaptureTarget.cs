using PlayniteAchievements.Services.UI;

namespace PlayniteAchievements.Services.Recording
{
    /// <summary>
    /// What unlock RECORDINGS film. They capture the whole primary display, so anything drawn on top
    /// of the game (for example another app's achievement notification) is part of the clip. The game
    /// window still decides when recording runs, and screenshots are unaffected: they keep their own
    /// game-window capture.
    /// </summary>
    internal static class RecordingCaptureTarget
    {
        /// <summary>True: recordings film the whole primary display instead of the game window.</summary>
        public static bool CapturesPrimaryDisplay => true;

        /// <summary>
        /// The clip variants to produce. A display recording already contains whatever notification
        /// is on screen, so compositing the toast card or the frame chrome on top would draw it
        /// twice: one clean clip is made whenever any variant was wanted.
        /// </summary>
        public static ScreenshotVariants ClipVariants(
            ScreenshotVariants resolved, bool capturesPrimaryDisplay)
        {
            if (resolved == ScreenshotVariants.None)
            {
                return ScreenshotVariants.None;
            }

            return capturesPrimaryDisplay ? ScreenshotVariants.Clean : resolved;
        }

        /// <summary>
        /// Whether an unlock screenshot may be decoded from the recording buffer. Buffered frames show
        /// the whole display, and screenshots must stay game-window-only, so for a display recording
        /// the caller uses its normal live capture of the game window instead.
        /// </summary>
        public static bool ScreenshotMayUseRecordingBuffer(bool capturesPrimaryDisplay) =>
            !capturesPrimaryDisplay;
    }
}
