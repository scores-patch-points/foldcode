// THE PERCEIVE SEAM in the plugin: which attachments are sent to the door's `perceive` event. Kept out of fold.ts so it is testable
// without the Effect runtime (test/fold-perceive.test.ts), like fold-register.ts.
//
// The door (khora opencode-doorway.mjs, onPerceive) answers with text, which is all this plugin carries. For audio, images and video
// it can add a short note labelled as a MEASUREMENT (khora senses/describe.mjs: the ear, Alcmaeon, and the eye, Alhazen), appended
// after any transcript or OCR and never in place of the media when the file has no words of its own. Video used to be skipped here,
// so a video's soundtrack could never be heard even though the door can hear it; it is forwarded now.

/** The largest attachment the door will read (khora PERCEIVE_MAX_BYTES). Keep the two in step. */
export const PERCEIVE_MAX_BYTES = 25 * 1024 * 1024
/** That size as base64 characters, which is what this plugin holds. */
export const PERCEIVE_MAX_B64 = Math.ceil(PERCEIVE_MAX_BYTES / 3) * 4

/** Media the door has a local organ for: pictures, sound, a video's soundtrack, and PDFs (text layer, then OCR). */
export const perceivableMime = (mime: string) => {
  const m = mime.toLowerCase()
  return m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/") || m === "application/pdf"
}

/** The door refuses a larger attachment as `media_too_large`, but only after receiving every byte. Skip the round trip; the media rides upstream untouched. */
export const tooLargeToPerceive = (dataBase64: string) => dataBase64.length > PERCEIVE_MAX_B64
