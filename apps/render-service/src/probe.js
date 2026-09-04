import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Probes a media file with ffprobe, returning exactly the `MediaMetadata` shape the editor
 * would have produced in the browser during `importMedia`.
 *
 * Doing this server-side means a headless caller (the ops API, the MCP server) can register
 * media without any browser or local ffmpeg of its own.
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

  let frameRate = 30;
  if (video?.r_frame_rate) {
    const [num, den] = String(video.r_frame_rate).split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) frameRate = num / den;
  }

  return {
    duration: Number(info.format?.duration ?? 0) || 0,
    width: video ? Number(video.width) || 0 : 0,
    height: video ? Number(video.height) || 0 : 0,
    frameRate,
    codec: video?.codec_name ?? audio?.codec_name ?? "",
    sampleRate: audio ? Number(audio.sample_rate) || 0 : 0,
    channels: audio ? Number(audio.channels) || 0 : 0,
    fileSize: Number(info.format?.size ?? 0) || 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}
