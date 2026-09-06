import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Codecs ffprobe reports for still images. A single frame of any of these is a picture,
// not a one-frame video - except animated gif/webp/apng, which have many frames and a
// real duration, and are handled as video below.
const STILL_IMAGE_CODECS = new Set([
  "png", "apng", "mjpeg", "jpeg", "jpegls", "bmp", "webp", "gif", "tiff", "targa", "ppm",
]);

/**
 * Probes a media file with ffprobe, returning `{ metadata, mediaType }`:
 *
 *   metadata  - exactly the `MediaMetadata` shape the editor produces in `importMedia`
 *   mediaType - "video" | "audio" | "image", the editor's `MediaItem.type`
 *
 * Doing this server-side means a headless caller (the ops API, the MCP server) can register
 * media without any browser or local ffmpeg of its own.
 *
 * Still images deliberately keep `duration: 0` and `hasVideo: false`, matching the browser's
 * `extractImageMetadata`. Zero is not a missing value here - it means "no inherent length",
 * and the clip's duration is the caller's to choose (project-kit defaults it to 5s). What a
 * still must NOT be is `type: "video"`: the export engine then tries to open a video track
 * that does not exist and fails with "Video load failed".
 */
export async function probeMedia(filePath) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { maxBuffer: 1 << 22 },
  );

  const info = JSON.parse(stdout);
  const video = info.streams?.find((stream) => stream.codec_type === "video");
  const audio = info.streams?.find((stream) => stream.codec_type === "audio");

  const duration = Number(info.format?.duration ?? 0) || 0;
  const fileSize = Number(info.format?.size ?? 0) || 0;
  const frameCount = Number(video?.nb_frames ?? 0) || 0;

  const isStillImage =
    Boolean(video) &&
    !audio &&
    STILL_IMAGE_CODECS.has(String(video.codec_name)) &&
    !(duration > 0 && frameCount > 1);

  if (isStillImage) {
    return {
      mediaType: "image",
      metadata: {
        duration: 0,
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        frameRate: 0,
        codec: "",
        sampleRate: 0,
        channels: 0,
        fileSize,
        hasVideo: false,
        hasAudio: false,
      },
    };
  }

  let frameRate = 30;
  if (video?.r_frame_rate) {
    const [num, den] = String(video.r_frame_rate).split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) frameRate = num / den;
  }

  return {
    mediaType: video ? "video" : "audio",
    metadata: {
      duration,
      width: video ? Number(video.width) || 0 : 0,
      height: video ? Number(video.height) || 0 : 0,
      frameRate,
      codec: video?.codec_name ?? audio?.codec_name ?? "",
      sampleRate: audio ? Number(audio.sample_rate) || 0 : 0,
      channels: audio ? Number(audio.channels) || 0 : 0,
      fileSize,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
    },
  };
}
