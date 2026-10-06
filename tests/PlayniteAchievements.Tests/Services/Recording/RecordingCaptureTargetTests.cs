using Microsoft.VisualStudio.TestTools.UnitTesting;
using PlayniteAchievements.Services.Recording;
using PlayniteAchievements.Services.UI;

namespace PlayniteAchievements.Services.Tests.Recording
{
    /// <summary>
    /// Recordings film the whole primary display. These pin what that means for the clip variants
    /// and for screenshots, which must stay game-window-only.
    /// </summary>
    [TestClass]
    public class RecordingCaptureTargetTests
    {
        [TestMethod]
        public void ThisBuild_RecordsThePrimaryDisplay()
        {
            Assert.IsTrue(RecordingCaptureTarget.CapturesPrimaryDisplay);
        }

        [TestMethod]
        public void DisplayRecordings_TurnEveryWantedVariantIntoOneCleanClip()
        {
            // The footage already contains whatever notification is on screen, so the toast
            // composite and the frame chrome would draw it a second time.
            Assert.AreEqual(
                ScreenshotVariants.Clean,
                RecordingCaptureTarget.ClipVariants(ScreenshotVariants.Clean, true));
            Assert.AreEqual(
                ScreenshotVariants.Clean,
                RecordingCaptureTarget.ClipVariants(ScreenshotVariants.WithToast, true));
            Assert.AreEqual(
                ScreenshotVariants.Clean,
                RecordingCaptureTarget.ClipVariants(ScreenshotVariants.Framed, true));
            Assert.AreEqual(
                ScreenshotVariants.Clean,
                RecordingCaptureTarget.ClipVariants(
                    ScreenshotVariants.Clean | ScreenshotVariants.WithToast | ScreenshotVariants.Framed,
                    true));
        }

        [TestMethod]
        public void NoVariantWanted_StaysNoClipForEitherTarget()
        {
            Assert.AreEqual(
                ScreenshotVariants.None,
                RecordingCaptureTarget.ClipVariants(ScreenshotVariants.None, true));
            Assert.AreEqual(
                ScreenshotVariants.None,
                RecordingCaptureTarget.ClipVariants(ScreenshotVariants.None, false));
        }

        [TestMethod]
        public void GameWindowRecordings_KeepTheResolvedVariants()
        {
            var all = ScreenshotVariants.Clean | ScreenshotVariants.WithToast | ScreenshotVariants.Framed;
            Assert.AreEqual(all, RecordingCaptureTarget.ClipVariants(all, false));
            Assert.AreEqual(
                ScreenshotVariants.WithToast,
                RecordingCaptureTarget.ClipVariants(ScreenshotVariants.WithToast, false));
        }

        [TestMethod]
        public void DisplayRecordings_NeverServeScreenshotsFromTheRecordingBuffer()
        {
            // Buffered frames show the whole display; screenshots stay a game-window capture.
            Assert.IsFalse(RecordingCaptureTarget.ScreenshotMayUseRecordingBuffer(true));
            Assert.IsTrue(RecordingCaptureTarget.ScreenshotMayUseRecordingBuffer(false));
        }

        [TestMethod]
        public void ThisBuild_KeepsScreenshotsOffTheRecordingBuffer()
        {
            Assert.IsFalse(RecordingCaptureTarget.ScreenshotMayUseRecordingBuffer(
                RecordingCaptureTarget.CapturesPrimaryDisplay));
        }
    }
}
