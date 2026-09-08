import type {
  MediaTrackInfo,
  ThumbnailResult,
  WaveformData,
  ExportSettings,
  ExportProgress,
  VideoFrameResult,
  FrameCacheEntry,
} from "./types";

import type {
  InputVideoTrack,
  InputAudioTrack,
  ConversionOptions,
  WrappedCanvas,
} from "mediabunny";

export const SUPPORTED_VIDEO_FORMATS = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
];

export const SUPPORTED_AUDIO_FORMATS = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/webm",
];

export const SUPPORTED_IMAGE_FORMATS = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

export function isSupportedFormat(mimeType: string): boolean {
  const baseMimeType = mimeType.split(";")[0].trim();
  return (
    SUPPORTED_VIDEO_FORMATS.includes(baseMimeType) ||
    SUPPORTED_AUDIO_FORMATS.includes(baseMimeType) ||
    SUPPORTED_IMAGE_FORMATS.includes(baseMimeType)
  );
}

export function inferMediaType(
  mimeType: string,
): "video" | "audio" | "image" | null {
  const baseMimeType = mimeType.split(";")[0].trim();
  if (SUPPORTED_VIDEO_FORMATS.includes(baseMimeType)) return "video";
  if (SUPPORTED_AUDIO_FORMATS.includes(baseMimeType)) return "audio";
  if (SUPPORTED_IMAGE_FORMATS.includes(baseMimeType)) return "image";
  return null;
}
/**
 * Minimal shapes for the packet-level API used by the export decoder's alpha repair.
 *
 * Declared locally rather than imported so that a mediabunny build (or a test double)
 * without `EncodedPacketSink` degrades to "no repair" instead of failing to construct.
 */
type AlphaPacket = {
  timestamp: number;
  sideData?: { alpha?: Uint8Array; alphaByteLength?: number };
  alphaToEncodedVideoChunk(): EncodedVideoChunk;
};

type AlphaPacketSink = {
  getFirstPacket(): Promise<AlphaPacket | null>;
  getKeyPacket(timestamp: number): Promise<AlphaPacket | null>;
  getNextPacket(packet: AlphaPacket): Promise<AlphaPacket | null>;
};

type MediaBunnyInput = {
  computeDuration(): Promise<number>;
  getMimeType(): Promise<string>;
  getPrimaryVideoTrack(): Promise<InputVideoTrack | null>;
  getPrimaryAudioTrack(): Promise<InputAudioTrack | null>;
  getAudioTracks(): Promise<InputAudioTrack[]>;
  getFormat(): Promise<unknown>;
  [Symbol.dispose]?: () => void;
};

export class ExportFrameDecoder {
  private input: MediaBunnyInput | null = null;
  private sink: InstanceType<typeof import("mediabunny").CanvasSink> | null = null;
  private mediabunny: typeof import("mediabunny");
  private file: File | Blob;
  private width?: number;
  private initialized = false;
  private reusableCanvas: OffscreenCanvas | null = null;
  private reusableCtx: OffscreenCanvasRenderingContext2D | null = null;
  private canvasIterator: AsyncIterator<WrappedCanvas> | null = null;
  private currentFrame: WrappedCanvas | null = null;
  private nextFrame: WrappedCanvas | null = null;
  private iteratorDone = false;
  private decodeTail: Promise<void> = Promise.resolve();

  // Alpha repair (see setupAlphaRepair). All null/false unless the track actually carries
  // alpha side data and the canvas geometry matches the source 1:1.
  private alphaPacketSink: AlphaPacketSink | null = null;
  private alphaDecoderConfig: VideoDecoderConfig | null = null;
  private alphaDecoder: VideoDecoder | null = null;
  private alphaNextPacket: AlphaPacket | null = null;
  private alphaFrames: VideoFrame[] = [];
  private alphaInFlight = 0;
  private alphaOutputWaiter: (() => void) | null = null;
  private alphaEndFlushed = false;
  private alphaBuffer: Uint8Array | null = null;
  private alphaFailed = false;

  constructor(mediabunny: typeof import("mediabunny"), file: File | Blob, width?: number) {
    this.mediabunny = mediabunny;
    this.file = file;
    this.width = width;
  }

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    const { Input, ALL_FORMATS, BlobSource, CanvasSink } = this.mediabunny;

    this.input = new Input({
      source: new BlobSource(this.file),
      formats: ALL_FORMATS,
    }) as unknown as MediaBunnyInput;

    const videoTrack = await this.input.getPrimaryVideoTrack();
    if (!videoTrack) {
      this.dispose();
      return false;
    }

    const canDecode = await videoTrack.canDecode();
    if (!canDecode) {
      this.dispose();
      return false;
    }

    // alpha: mediabunny's CanvasSink defaults to an opaque canvas, which bakes a black
    // background into transparent (VP9 alpha_mode=1) clips instead of letting lower
    // tracks show through. See CanvasSinkOptions in mediabunny's media-sink.d.ts.
    const sinkOptions: Record<string, unknown> = { poolSize: 2, alpha: true };
    if (this.width) {
      const aspectRatio = videoTrack.displayHeight / videoTrack.displayWidth;
      sinkOptions.width = this.width;
      sinkOptions.height = Math.round(this.width * aspectRatio);
      sinkOptions.fit = "contain";
    }

    this.sink = new CanvasSink(videoTrack, sinkOptions);
    await this.setupAlphaRepair(videoTrack, sinkOptions);
    this.initialized = true;
    return true;
  }

  /**
   * Arms alpha repair, if this track can benefit from it.
   *
   * CanvasSink's frames come back as packed BGRA from Chrome's WebCodecs VP9-alpha decode,
   * which collapses antialiased contour pixels: on a stem edge the renderer drew
   * `0, 12, 192, 255`, the canvas reads `0, 0, 206, 255`, and across five frames only
   * 31-37% of the partially-transparent pixels survive. VP9 stores alpha as its own
   * greyscale stream, though, and decoding *that* through its own VideoDecoder returns
   * planar I420 whose Y plane is bit-exact with ffmpeg (0 of 2,073,600 pixels differ). So
   * the colour and the frame selection keep coming from CanvasSink, and only the alpha
   * channel is overwritten afterwards. See Stage 19 in NOTES.md.
   *
   * Bails out - leaving behaviour exactly as before - when anything is missing or when the
   * canvas is not 1:1 with the source, because a scaled or letterboxed canvas would need the
   * alpha plane resampled through CanvasSink's own `fit` geometry, and getting that subtly
   * wrong is worse than not repairing.
   */
  private async setupAlphaRepair(
    videoTrack: InputVideoTrack,
    sinkOptions: Record<string, unknown>,
  ): Promise<void> {
    try {
      const EncodedPacketSink = (
        this.mediabunny as unknown as {
          EncodedPacketSink?: new (track: InputVideoTrack) => AlphaPacketSink;
        }
      ).EncodedPacketSink;
      if (!EncodedPacketSink || typeof VideoDecoder === "undefined") return;

      // The canvas CanvasSink will hand back, versus the source's own pixels.
      const canvasWidth = (sinkOptions.width as number | undefined) ?? videoTrack.displayWidth;
      const canvasHeight = (sinkOptions.height as number | undefined) ?? videoTrack.displayHeight;
      if (canvasWidth !== videoTrack.displayWidth || canvasHeight !== videoTrack.displayHeight) {
        return;
      }

      const getDecoderConfig = (
        videoTrack as unknown as { getDecoderConfig?: () => Promise<VideoDecoderConfig | null> }
      ).getDecoderConfig;
      if (typeof getDecoderConfig !== "function") return;
      const decoderConfig = await getDecoderConfig.call(videoTrack);
      if (!decoderConfig) return;

      const sink = new EncodedPacketSink(videoTrack);
      const first = await sink.getFirstPacket();
      // Opaque clips carry no alpha side data: nothing to repair, nothing to pay for.
      if (!first?.sideData?.alpha) return;

      this.alphaPacketSink = sink;
      this.alphaDecoderConfig = decoderConfig;
    } catch {
      // Any surprise here means "no repair", never a failed export.
      this.alphaPacketSink = null;
      this.alphaDecoderConfig = null;
    }
  }

  /**
   * Slack allowed when matching a requested timestamp to a source frame, in seconds.
   *
   * Source frame timestamps are quantised by the container. Matroska/WebM stores them on a
   * 1ms grid (TimecodeScale defaults to 1,000,000ns and ffmpeg's webm muxer does not expose
   * it), so a 30fps clip's frames land on 0.033 / 0.067 / 0.100 rather than exact multiples
   * of 1/30 — an error of up to +-0.5ms. Comparing those against exact k/fps request times
   * with only 1e-8 of slack rejected the correct frame roughly two times in three, and the
   * export then repeated the previous frame and skipped the next: a 3-frame repeat/skip
   * cycle that reads as judder while the file still reports a clean 30fps.
   *
   * 1.5ms absorbs that quantisation with margin and stays far below any real frame duration
   * (a 240fps source has 4.2ms frames), and the effective value is additionally capped at a
   * quarter of the observed frame spacing so it can never span a whole frame.
   */
  private static readonly TIMESTAMP_TOLERANCE = 0.0015;

  /** Tolerance for the current decode position, narrowed to the local frame spacing. */
  private timestampTolerance(): number {
    const spacing =
      this.currentFrame && this.nextFrame
        ? this.nextFrame.timestamp - this.currentFrame.timestamp
        : 0;
    return spacing > 0
      ? Math.min(ExportFrameDecoder.TIMESTAMP_TOLERANCE, spacing * 0.25)
      : ExportFrameDecoder.TIMESTAMP_TOLERANCE;
  }

  async getFrame(timestamp: number): Promise<OffscreenCanvas | null> {
    const framePromise = this.decodeTail.then(() => this.getSequentialFrame(timestamp));
    this.decodeTail = framePromise.then(
      () => undefined,
      () => undefined,
    );
    return framePromise;
  }

  private async getSequentialFrame(timestamp: number): Promise<OffscreenCanvas | null> {
    if (!this.sink) return null;

    // Start a new sequential decode for the first request or whenever the
    // timeline moves backwards (reverse playback, a loop, or a later clip
    // reusing the same media from an earlier in-point).
    if (!this.canvasIterator || (this.currentFrame && timestamp < this.currentFrame.timestamp - 1e-8)) {
      await this.resetCanvasIterator(timestamp);
    }

    if (!this.currentFrame) return null;

    // Keep one decoded frame of lookahead so selection exactly matches
    // CanvasSink.getCanvas(): the last source frame starting at or before the
    // requested timestamp. CanvasSink's two-canvas pool keeps both frames
    // stable while we copy the selected one below.
    while (true) {
      if (!this.nextFrame && !this.iteratorDone) {
        const next = await this.canvasIterator!.next();
        if (next.done) {
          this.iteratorDone = true;
        } else {
          this.nextFrame = next.value;
        }
      }

      if (this.nextFrame && this.nextFrame.timestamp <= timestamp + this.timestampTolerance()) {
        this.currentFrame = this.nextFrame;
        this.nextFrame = null;
        continue;
      }
      break;
    }

    // Same tolerance as the advance above; without it the first frame of a clip whose
    // timestamp rounded up would be dropped entirely. The backwards-seek check further up
    // keeps its 1e-8, which errs towards re-decoding rather than showing a stale frame.
    if (this.currentFrame.timestamp > timestamp + this.timestampTolerance()) return null;

    const w = this.currentFrame.canvas.width;
    const h = this.currentFrame.canvas.height;

    if (!this.reusableCanvas || this.reusableCanvas.width !== w || this.reusableCanvas.height !== h) {
      this.reusableCanvas = new OffscreenCanvas(w, h);
      this.reusableCtx = this.reusableCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    }

    this.reusableCtx!.clearRect(0, 0, w, h);
    this.reusableCtx!.drawImage(this.currentFrame.canvas, 0, 0);
    await this.repairAlpha(this.currentFrame.timestamp, w, h);
    return this.reusableCanvas;
  }

  /**
   * Overwrites the copied canvas's alpha channel with the separately-decoded alpha plane.
   *
   * Matched on the canvas frame's own timestamp rather than on the requested time, so the
   * "last frame at or before" selection lives in exactly one place and the two streams
   * cannot drift apart. Both come from the same packets, so an exact match exists; if one is
   * not found the canvas is left as CanvasSink produced it, which is today's behaviour.
   */
  private async repairAlpha(timestamp: number, w: number, h: number): Promise<void> {
    if (!this.alphaPacketSink || !this.alphaDecoderConfig || this.alphaFailed) return;

    try {
      const frame = await this.alphaFrameAt(timestamp);
      if (!frame) return;

      const layout = await this.copyAlphaPlane(frame);
      if (!layout) return;
      const { plane, stride } = layout;

      const image = this.reusableCtx!.getImageData(0, 0, w, h);
      const pixels = image.data;
      for (let y = 0; y < h; y++) {
        const planeRow = y * stride;
        const pixelRow = y * w * 4;
        for (let x = 0; x < w; x++) {
          pixels[pixelRow + x * 4 + 3] = plane[planeRow + x];
        }
      }
      this.reusableCtx!.putImageData(image, 0, 0);
    } catch {
      // One failure disarms repair for the rest of the export rather than throwing away
      // the export or repeating the cost on every frame.
      this.alphaFailed = true;
      this.releaseAlphaFrames();
    }
  }

  /**
   * The decoded alpha frame whose timestamp matches `timestamp`, decoding forward as needed.
   * Frames before the target are closed as they are passed over.
   */
  private async alphaFrameAt(timestamp: number): Promise<VideoFrame | null> {
    // Both timestamps come from the same container fields, so this only absorbs the
    // microsecond<->second conversion, not the 1ms container grid Stage 17 deals with.
    const epsilon = 1e-6;

    for (;;) {
      while (this.alphaFrames.length > 0) {
        const head = this.alphaFrames[0]!;
        const headTimestamp = head.timestamp / 1e6;
        if (headTimestamp < timestamp - epsilon) {
          this.alphaFrames.shift();
          head.close();
          continue;
        }
        return headTimestamp <= timestamp + epsilon ? head : null;
      }
      if (this.alphaFailed) return null;
      if (!(await this.pumpAlphaDecoder())) return null;
    }
  }

  /**
   * Advances the alpha stream until at least one more frame is available, or reports that
   * the stream is finished.
   *
   * Two constraints shape this, both learned the hard way:
   *
   * - **Never flush mid-stream.** Chrome rejects the next chunk with "A key frame is
   *   required after configure() or flush()", so flush is only usable once, at end of
   *   input, where nothing follows it.
   * - **"All packets fed" is not "no more frames".** The first attempt fed far ahead and
   *   treated exhausted input as a finished stream, so it gave up on a transiently empty
   *   queue while the frame it wanted was still in flight - and by then it had already
   *   discarded that frame. Input is now fed only while decoded frames are outstanding,
   *   bounded by MAX_IN_FLIGHT, and the loop waits for output instead of concluding.
   */
  private async pumpAlphaDecoder(): Promise<boolean> {
    if (!this.alphaPacketSink || !this.alphaDecoderConfig) return false;

    if (!this.alphaDecoder) {
      this.alphaDecoder = new VideoDecoder({
        output: (frame) => {
          this.alphaInFlight--;
          this.alphaFrames.push(frame);
          const waiter = this.alphaOutputWaiter;
          this.alphaOutputWaiter = null;
          waiter?.();
        },
        error: () => {
          this.alphaFailed = true;
          const waiter = this.alphaOutputWaiter;
          this.alphaOutputWaiter = null;
          waiter?.();
        },
      });
      this.alphaDecoder.configure(this.alphaDecoderConfig);
    }

    // The consumer wants one specific frame and discards everything before it, so running
    // far ahead only pins full-resolution frames in memory.
    const MAX_IN_FLIGHT = 6;

    for (;;) {
      if (this.alphaFailed) return false;
      if (this.alphaFrames.length > 0) return true;

      while (this.alphaNextPacket && this.alphaInFlight < MAX_IN_FLIGHT) {
        const packet = this.alphaNextPacket;
        this.alphaNextPacket = await this.alphaPacketSink.getNextPacket(packet);
        if (packet.sideData?.alpha) {
          this.alphaDecoder.decode(packet.alphaToEncodedVideoChunk());
          this.alphaInFlight++;
        }
      }
      if (this.alphaFrames.length > 0) return true;

      if (!this.alphaNextPacket) {
        // End of input: a single flush is safe here because nothing more will be decoded.
        if (this.alphaEndFlushed) return false;
        this.alphaEndFlushed = true;
        await this.alphaDecoder.flush();
        return !this.alphaFailed && this.alphaFrames.length > 0;
      }

      await new Promise<void>((resolve) => {
        this.alphaOutputWaiter = resolve;
      });
    }
  }

  /** Copies a decoded alpha frame's Y plane, which is the alpha channel at full resolution. */
  private async copyAlphaPlane(
    frame: VideoFrame,
  ): Promise<{ plane: Uint8Array; stride: number } | null> {
    const size = frame.allocationSize();
    if (!this.alphaBuffer || this.alphaBuffer.byteLength < size) {
      this.alphaBuffer = new Uint8Array(size);
    }
    const layout = await frame.copyTo(this.alphaBuffer);
    const plane0 = layout?.[0];
    if (!plane0) return null;
    // codedWidth is padded to a multiple of 64 by VP9 (1984 for a 1920-wide clip), so the
    // row stride is read from the layout rather than assumed to be the display width.
    return {
      plane: this.alphaBuffer.subarray(plane0.offset),
      stride: plane0.stride,
    };
  }

  private releaseAlphaFrames(): void {
    for (const frame of this.alphaFrames) frame.close();
    this.alphaFrames = [];
    this.alphaInFlight = 0;
    this.alphaOutputWaiter = null;
    this.alphaEndFlushed = false;
  }

  /** Restarts the alpha stream from the key packet at or before `timestamp`. */
  private async resetAlphaDecoder(timestamp: number): Promise<void> {
    if (!this.alphaPacketSink || this.alphaFailed) return;
    this.releaseAlphaFrames();
    try {
      if (this.alphaDecoder) {
        // reset() (not flush()) discards pending work and requires a key packet next,
        // which is exactly what seeking to a key packet provides.
        this.alphaDecoder.reset();
        this.alphaDecoder.configure(this.alphaDecoderConfig!);
      }
      this.alphaNextPacket =
        (await this.alphaPacketSink.getKeyPacket(timestamp)) ??
        (await this.alphaPacketSink.getFirstPacket());
    } catch {
      this.alphaFailed = true;
    }
  }

  private async resetCanvasIterator(timestamp: number): Promise<void> {
    await this.canvasIterator?.return?.();
    this.currentFrame = null;
    this.nextFrame = null;
    this.iteratorDone = false;
    this.canvasIterator = this.sink!.canvases(timestamp)[Symbol.asyncIterator]();
    await this.resetAlphaDecoder(timestamp);

    const first = await this.canvasIterator.next();
    if (first.done) {
      this.iteratorDone = true;
      return;
    }
    this.currentFrame = first.value;
  }

  dispose(): void {
    void this.canvasIterator?.return?.();
    if (this.input) {
      this.input[Symbol.dispose]?.();
      this.input = null;
    }
    this.sink = null;
    this.canvasIterator = null;
    this.currentFrame = null;
    this.nextFrame = null;
    this.iteratorDone = false;
    this.decodeTail = Promise.resolve();
    this.reusableCanvas = null;
    this.reusableCtx = null;
    this.releaseAlphaFrames();
    if (this.alphaDecoder) {
      try { this.alphaDecoder.close(); } catch { /* already closed */ }
      this.alphaDecoder = null;
    }
    this.alphaPacketSink = null;
    this.alphaDecoderConfig = null;
    this.alphaNextPacket = null;
    this.alphaBuffer = null;
    this.alphaFailed = false;
    this.initialized = false;
  }
}

export class MediaBunnyEngine {
  private initialized = false;
  private mediabunny: typeof import("mediabunny") | null = null;
  private frameCache: Map<string, FrameCacheEntry> = new Map();
  private readonly MAX_CACHE_SIZE = 5;
  private exportDecoders: Map<string, ExportFrameDecoder> = new Map();

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Dynamic import to support lazy loading
      this.mediabunny = await import("mediabunny");
      this.initialized = true;
    } catch (error) {
      console.warn("MediaBunny not available, will use fallback");
      throw new Error("MediaBunny initialization failed");
    }
  }

  isAvailable(): boolean {
    return this.initialized && this.mediabunny !== null;
  }

  clearFrameCache(): void {
    for (const entry of this.frameCache.values()) {
      if (entry.image instanceof OffscreenCanvas) {
        entry.image.width = 0;
        entry.image.height = 0;
      }
    }
    this.frameCache.clear();
  }

  getFrameCacheSize(): number {
    return this.frameCache.size;
  }

  async createExportDecoder(mediaId: string, file: File | Blob, width?: number): Promise<ExportFrameDecoder | null> {
    this.ensureInitialized();

    const existing = this.exportDecoders.get(mediaId);
    if (existing) {
      return existing;
    }

    const decoder = new ExportFrameDecoder(this.mediabunny!, file, width);
    const success = await decoder.initialize();
    if (!success) {
      return null;
    }

    this.exportDecoders.set(mediaId, decoder);
    return decoder;
  }

  getExportDecoder(mediaId: string): ExportFrameDecoder | null {
    return this.exportDecoders.get(mediaId) || null;
  }

  disposeExportDecoder(mediaId: string): void {
    const decoder = this.exportDecoders.get(mediaId);
    if (decoder) {
      decoder.dispose();
      this.exportDecoders.delete(mediaId);
    }
  }

  disposeAllExportDecoders(): void {
    for (const decoder of this.exportDecoders.values()) {
      decoder.dispose();
    }
    this.exportDecoders.clear();
  }

  private ensureInitialized(): void {
    if (!this.mediabunny) {
      throw new Error("MediaBunny not initialized. Call initialize() first.");
    }
  }

  async createInput(file: File | Blob): Promise<MediaBunnyInput> {
    this.ensureInitialized();
    const { Input, ALL_FORMATS, BlobSource } = this.mediabunny!;

    return new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
  }

  async validateFormat(file: File | Blob): Promise<{
    supported: boolean;
    format: string | null;
    error?: string;
  }> {
    const mimeType = file.type;
    if (!isSupportedFormat(mimeType)) {
      return {
        supported: false,
        format: null,
        error: `Unsupported format: ${
          mimeType || "unknown"
        }. Supported formats: MP4, WebM, MOV, MP3, WAV, AAC, JPG, PNG, WebP`,
      };
    }

    // Images don't need MediaBunny validation - they're already supported
    if (mimeType.startsWith("image/")) {
      return {
        supported: true,
        format: mimeType,
      };
    }

    try {
      const input = await this.createInput(file);
      const format = await input.getFormat();

      input[Symbol.dispose]?.();

      if (!format) {
        return {
          supported: false,
          format: null,
          error: "Could not determine file format. The file may be corrupted.",
        };
      }

      return {
        supported: true,
        format: mimeType,
      };
    } catch (error) {
      return {
        supported: false,
        format: null,
        error: `Failed to parse file: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  private async extractImageMetadata(
    file: File | Blob,
    mimeType: string,
  ): Promise<MediaTrackInfo> {
    // Load image to get dimensions
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = objectUrl;
      });

      return {
        duration: 0, // Images have no duration
        width: img.naturalWidth,
        height: img.naturalHeight,
        frameRate: 0,
        codec: "",
        sampleRate: 0,
        channels: 0,
        fileSize: file.size,
        mimeType,
        hasVideo: false,
        hasAudio: false,
        rotation: 0,
        canDecode: true,
        videoBitrate: 0,
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async extractMetadata(file: File | Blob): Promise<MediaTrackInfo> {
    // Special handling for images - MediaBunny doesn't process static images well
    const fileType = file instanceof File ? file.type : "";
    if (fileType.startsWith("image/")) {
      return await this.extractImageMetadata(file, fileType);
    }

    const input = await this.createInput(file);

    try {
      const duration = await input.computeDuration();
      const mimeType = await input.getMimeType();

      const videoTrack = await input.getPrimaryVideoTrack();
      const audioTrack = await input.getPrimaryAudioTrack();

      let width = 0;
      let height = 0;
      let frameRate = 0;
      let videoCodec = "";
      let rotation = 0;
      let canDecodeVideo = false;
      let videoBitrate = 0;

      if (videoTrack) {
        width = videoTrack.displayWidth;
        height = videoTrack.displayHeight;
        rotation = videoTrack.rotation || 0;
        videoCodec = videoTrack.codec || "";
        canDecodeVideo = await videoTrack.canDecode();

        // Compute frame rate and bitrate from packet stats
        try {
          const stats = await videoTrack.computePacketStats(100);
          frameRate = stats.averagePacketRate || 30;
          videoBitrate = stats.averageBitrate || 0;
        } catch {
          frameRate = 30; // Default
        }
      }

      let sampleRate = 0;
      let channels = 0;
      let audioCodec = "";
      let canDecodeAudio = false;
      let audioTrackCount = 0;

      if (audioTrack) {
        sampleRate = audioTrack.sampleRate;
        channels = audioTrack.numberOfChannels;
        audioCodec = audioTrack.codec || "";
        canDecodeAudio = await audioTrack.canDecode();
      }

      try {
        const allAudioTracks = await input.getAudioTracks();
        audioTrackCount = allAudioTracks.length;
      } catch {
        audioTrackCount = audioTrack ? 1 : 0;
      }

      return {
        duration,
        width,
        height,
        frameRate,
        codec: videoCodec || audioCodec,
        sampleRate,
        channels,
        fileSize: file.size,
        mimeType,
        hasVideo: !!videoTrack,
        hasAudio: !!audioTrack,
        rotation,
        canDecode: canDecodeVideo || canDecodeAudio,
        videoBitrate,
        audioTrackCount,
      };
    } finally {
      input[Symbol.dispose]?.();
    }
  }

  async generateThumbnails(
    file: File | Blob,
    count: number = 5,
    width: number = 320,
  ): Promise<ThumbnailResult[]> {
    this.ensureInitialized();
    const { CanvasSink } = this.mediabunny!;
    const input = await this.createInput(file);

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        return [];
      }

      const canDecode = await videoTrack.canDecode();
      if (!canDecode) {
        throw new Error("Cannot decode video track");
      }
      const aspectRatio = videoTrack.displayHeight / videoTrack.displayWidth;
      const height = Math.round(width * aspectRatio);

      const sink = new CanvasSink(videoTrack, {
        width,
        height,
        fit: "contain" as const,
        poolSize: Math.min(count, 10), // Limit pool size for memory efficiency
      });

      const startTimestamp = await videoTrack.getFirstTimestamp();
      const endTimestamp = await videoTrack.computeDuration();
      const duration = endTimestamp - startTimestamp;
      const timestamps =
        count === 1
          ? [startTimestamp]
          : Array.from(
              { length: count },
              (_, i) => startTimestamp + (i / (count - 1)) * duration,
            );

      const thumbnails: ThumbnailResult[] = [];

      for await (const result of sink.canvasesAtTimestamps(timestamps)) {
        if (result) {
          // Clone the canvas since the pool reuses them
          const clone = new OffscreenCanvas(
            result.canvas.width,
            result.canvas.height,
          );
          const ctx = clone.getContext("2d");
          if (ctx) {
            ctx.drawImage(result.canvas, 0, 0);
          }
          let dataUrl: string | undefined;
          try {
            const blob = await clone.convertToBlob({
              type: "image/jpeg",
              quality: 0.7,
            });
            dataUrl = URL.createObjectURL(blob);
          } catch {}

          thumbnails.push({
            timestamp: result.timestamp,
            canvas: clone,
            dataUrl,
          });
        }
      }

      return thumbnails;
    } finally {
      input[Symbol.dispose]?.();
    }
  }

  async generateFilmstripThumbnails(
    file: File | Blob,
    duration: number,
    thumbnailWidth: number = 80,
    interval: number = 1,
  ): Promise<ThumbnailResult[]> {
    this.ensureInitialized();
    const { CanvasSink } = this.mediabunny!;
    const input = await this.createInput(file);

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        return [];
      }

      const canDecode = await videoTrack.canDecode();
      if (!canDecode) {
        throw new Error("Cannot decode video track");
      }
      const aspectRatio = videoTrack.displayHeight / videoTrack.displayWidth;
      const height = Math.round(thumbnailWidth * aspectRatio);
      const count = Math.max(1, Math.ceil(duration / interval));

      const sink = new CanvasSink(videoTrack, {
        width: thumbnailWidth,
        height,
        fit: "cover" as const,
        poolSize: Math.min(count, 20),
      });

      const startTimestamp = await videoTrack.getFirstTimestamp();
      const timestamps = Array.from(
        { length: count },
        (_, i) => startTimestamp + i * interval,
      );

      const thumbnails: ThumbnailResult[] = [];

      for await (const result of sink.canvasesAtTimestamps(timestamps)) {
        if (result) {
          // Clone the canvas
          const clone = new OffscreenCanvas(
            result.canvas.width,
            result.canvas.height,
          );
          const ctx = clone.getContext("2d");
          if (ctx) {
            ctx.drawImage(result.canvas, 0, 0);
          }
          let dataUrl: string | undefined;
          try {
            const blob = await clone.convertToBlob({
              type: "image/jpeg",
              quality: 0.6,
            });
            dataUrl = URL.createObjectURL(blob);
          } catch {}

          thumbnails.push({
            timestamp: result.timestamp,
            canvas: clone,
            dataUrl,
          });
        }
      }

      return thumbnails;
    } finally {
      input[Symbol.dispose]?.();
    }
  }

  async getFrameAtTime(
    file: File | Blob,
    timestamp: number,
    width?: number,
  ): Promise<VideoFrameResult | null> {
    this.ensureInitialized();
    const { CanvasSink } = this.mediabunny!;
    const fileName = "name" in file ? file.name : "blob";
    const cacheKey = `${fileName}-${file.size}-${timestamp}-${width || "auto"}`;
    const cached = this.frameCache.get(cacheKey);
    if (cached) {
      cached.lastAccessed = Date.now();
      return {
        timestamp: cached.timestamp,
        duration: 0, // Cached frames might not have duration stored, or we can add it to cache
        canvas: cached.image,
        width: cached.width,
        height: cached.height,
      };
    }

    const input = await this.createInput(file);

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        return null;
      }

      const canDecode = await videoTrack.canDecode();
      if (!canDecode) {
        throw new Error("Cannot decode video track");
      }

      // alpha, for the same reason as ExportFrameDecoder: CanvasSink defaults to an opaque
      // canvas, so a transparent (VP9 alpha_mode=1) clip comes back with black baked into
      // every transparent pixel. This is the frame source `renderFrame` falls back to when
      // no ExportFrameDecoder has been primed — which is exactly what render_preview_frame
      // does — so without it the whole clip is opaque and, on the top track, paints over
      // every track below instead of compositing. Stage 7 fixed the export's decoder and
      // this call site was missed; see Stage 20 in NOTES.md.
      const sinkOptions: Record<string, unknown> = { poolSize: 1, alpha: true };
      if (width) {
        const aspectRatio = videoTrack.displayHeight / videoTrack.displayWidth;
        sinkOptions.width = width;
        sinkOptions.height = Math.round(width * aspectRatio);
        sinkOptions.fit = "contain";
      }

      const sink = new CanvasSink(videoTrack, sinkOptions);
      const result = await sink.getCanvas(timestamp);

      if (!result) {
        return null;
      }

      // Clone the canvas
      const clone = new OffscreenCanvas(
        result.canvas.width,
        result.canvas.height,
      );
      const ctx = clone.getContext("2d");
      if (ctx) {
        ctx.drawImage(result.canvas, 0, 0);
      }

      // Cache the result
      if (this.frameCache.size >= this.MAX_CACHE_SIZE) {
        let oldestKey = "";
        let oldestTime = Infinity;
        for (const [key, entry] of this.frameCache.entries()) {
          if (entry.lastAccessed < oldestTime) {
            oldestTime = entry.lastAccessed;
            oldestKey = key;
          }
        }
        if (oldestKey) {
          this.frameCache.delete(oldestKey);
        }
      }

      this.frameCache.set(cacheKey, {
        timestamp: result.timestamp,
        image: clone,
        width: clone.width,
        height: clone.height,
        lastAccessed: Date.now(),
      });

      return {
        timestamp: result.timestamp,
        duration: result.duration,
        canvas: clone,
        width: clone.width,
        height: clone.height,
      };
    } finally {
      input[Symbol.dispose]?.();
    }
  }

  async generateWaveform(
    file: File | Blob,
    samplesPerSecond: number = 100,
  ): Promise<WaveformData> {
    this.ensureInitialized();
    const { AudioSampleSink } = this.mediabunny!;
    const input = await this.createInput(file);

    try {
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack) {
        throw new Error("No audio track found");
      }

      const canDecode = await audioTrack.canDecode();
      if (!canDecode) {
        throw new Error("Cannot decode audio track");
      }

      const sink = new AudioSampleSink(audioTrack);
      const duration = await audioTrack.computeDuration();
      const totalSamples = Math.ceil(duration * samplesPerSecond);

      const peaks: number[] = [];
      const rms: number[] = [];
      const timestamps = Array.from(
        { length: totalSamples },
        (_, i) => i / samplesPerSecond,
      );

      for await (const sample of sink.samplesAtTimestamps(timestamps)) {
        if (!sample) {
          peaks.push(0);
          rms.push(0);
          continue;
        }
        const bytesNeeded = sample.allocationSize({
          format: "f32",
          planeIndex: 0,
        });
        const floats = new Float32Array(bytesNeeded / 4);
        sample.copyTo(floats, { format: "f32", planeIndex: 0 });
        let peak = 0;
        let sumSquares = 0;
        for (let i = 0; i < floats.length; i++) {
          const abs = Math.abs(floats[i]);
          peak = Math.max(peak, abs);
          sumSquares += floats[i] * floats[i];
        }

        peaks.push(peak);
        rms.push(Math.sqrt(sumSquares / floats.length));

        sample.close();
      }

      return {
        peaks: new Float32Array(peaks),
        rms: new Float32Array(rms),
        sampleRate: samplesPerSecond,
        duration,
        samplesPerSecond,
      };
    } finally {
      input[Symbol.dispose]?.();
    }
  }

  async convertMedia(
    file: File | Blob,
    settings: ExportSettings,
    onProgress?: (progress: ExportProgress) => void,
    signal?: AbortSignal,
  ): Promise<Blob> {
    this.ensureInitialized();
    const {
      Input,
      Output,
      Conversion,
      ALL_FORMATS,
      BlobSource,
      BufferTarget,
      Mp4OutputFormat,
      WebMOutputFormat,
      MovOutputFormat,
      Mp3OutputFormat,
      QUALITY_HIGH,
      QUALITY_MEDIUM,
    } = this.mediabunny!;

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
    let outputFormat;
    switch (settings.format) {
      case "webm":
        outputFormat = new WebMOutputFormat();
        break;
      case "mov":
        outputFormat = new MovOutputFormat();
        break;
      case "mp3":
        outputFormat = new Mp3OutputFormat();
        break;
      case "mp4":
      default:
        outputFormat = new Mp4OutputFormat({ fastStart: "in-memory" });
        break;
    }

    const output = new Output({
      format: outputFormat,
      target: new BufferTarget(),
    });
    const conversionOptions: Record<string, unknown> = {
      input,
      output,
    };

    // Video options
    if (settings.width || settings.height || settings.videoBitrate) {
      conversionOptions.video = {
        ...(settings.width && { width: settings.width }),
        ...(settings.height && { height: settings.height }),
        ...(settings.width && settings.height && { fit: "contain" }),
        ...(settings.frameRate && { frameRate: settings.frameRate }),
        bitrate: settings.videoBitrate || QUALITY_HIGH,
      };
    }

    // Audio options
    if (settings.audioBitrate || settings.sampleRate || settings.channels) {
      conversionOptions.audio = {
        ...(settings.audioBitrate && { bitrate: settings.audioBitrate }),
        ...(settings.sampleRate && { sampleRate: settings.sampleRate }),
        ...(settings.channels && { numberOfChannels: settings.channels }),
      };
    }

    // Discard audio for video-only export
    if (
      settings.format === "mp4" ||
      settings.format === "webm" ||
      settings.format === "mov"
    ) {
      if (!conversionOptions.audio) {
        conversionOptions.audio = { bitrate: QUALITY_MEDIUM };
      }
    }

    const conversion = await Conversion.init(
      conversionOptions as ConversionOptions,
    );

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .map((t: { reason: string }) => t.reason)
        .join(", ");
      throw new Error(`Conversion invalid: ${reasons}`);
    }

    // Warn about discarded tracks that were not explicitly discarded
    if (conversion.discardedTracks.length > 0) {
      console.warn(
        "Some tracks were discarded during conversion:",
        conversion.discardedTracks,
      );
    }
    if (onProgress) {
      let lastProgress = 0;
      conversion.onProgress = (progress: number) => {
        if (progress > lastProgress) {
          lastProgress = progress;
          onProgress({
            phase: progress < 1 ? "encoding" : "complete",
            progress,
            currentFrame: 0,
            totalFrames: 0,
            estimatedTimeRemaining: 0,
          });
        }
      };
    }
    if (signal) {
      signal.addEventListener("abort", () => {
        conversion.cancel();
      });
    }

    try {
      await conversion.execute();
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw error;
    }
    const buffer = output.target.buffer;
    if (!buffer) {
      throw new Error("Output buffer is empty");
    }
    const mimeType = this.getMimeTypeForFormat(settings.format);

    return new Blob([buffer], { type: mimeType });
  }

  async extractAudio(
    file: File | Blob,
    format: "mp3" | "wav" | "aac" = "mp3",
    onProgress?: (progress: ExportProgress) => void,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.convertMedia(
      file,
      {
        format: format as ExportSettings["format"],
        audioBitrate: 128000,
        sampleRate: 48000,
        channels: 2,
      },
      onProgress,
      signal,
    );
  }

  async trimMedia(
    file: File | Blob,
    startTime: number,
    endTime: number,
    settings?: Partial<ExportSettings>,
    onProgress?: (progress: ExportProgress) => void,
    signal?: AbortSignal,
  ): Promise<Blob> {
    this.ensureInitialized();
    const {
      Input,
      Output,
      Conversion,
      ALL_FORMATS,
      BlobSource,
      BufferTarget,
      Mp4OutputFormat,
    } = this.mediabunny!;

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });

    const conversion = await Conversion.init({
      input,
      output,
      trim: {
        start: startTime,
        end: endTime,
      },
      ...(settings?.videoBitrate && {
        video: { bitrate: settings.videoBitrate },
      }),
      ...(settings?.audioBitrate && {
        audio: { bitrate: settings.audioBitrate },
      }),
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .map((t: { reason: string }) => t.reason)
        .join(", ");
      throw new Error(`Trim conversion invalid: ${reasons}`);
    }

    if (onProgress) {
      conversion.onProgress = (progress: number) => {
        onProgress({
          phase: progress < 1 ? "encoding" : "complete",
          progress,
          currentFrame: 0,
          totalFrames: 0,
          estimatedTimeRemaining: 0,
        });
      };
    }
    if (signal) {
      signal.addEventListener("abort", () => {
        conversion.cancel();
      });
    }

    try {
      await conversion.execute();
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw error;
    }

    if (!output.target.buffer) {
      throw new Error("Output buffer is empty");
    }
    return new Blob([output.target.buffer], { type: "video/mp4" });
  }

  private getMimeTypeForFormat(format: ExportSettings["format"]): string {
    switch (format) {
      case "mp4":
        return "video/mp4";
      case "webm":
        return "video/webm";
      case "mov":
        return "video/quicktime";
      case "mp3":
        return "audio/mpeg";
      case "wav":
        return "audio/wav";
      case "aac":
        return "audio/aac";
      default:
        return "video/mp4";
    }
  }

  async checkCodecSupport(): Promise<{
    video: string[];
    audio: string[];
  }> {
    this.ensureInitialized();
    const { getEncodableVideoCodecs, getEncodableAudioCodecs } =
      this.mediabunny!;

    const [videoCodecs, audioCodecs] = await Promise.all([
      getEncodableVideoCodecs(),
      getEncodableAudioCodecs(),
    ]);

    return {
      video: videoCodecs,
      audio: audioCodecs,
    };
  }

  async getBestVideoCodec(
    width: number,
    height: number,
  ): Promise<string | null> {
    this.ensureInitialized();
    const { getFirstEncodableVideoCodec, Mp4OutputFormat } = this.mediabunny!;

    const format = new Mp4OutputFormat();
    const supportedCodecs = format.getSupportedVideoCodecs();

    try {
      const codec = await getFirstEncodableVideoCodec(supportedCodecs, {
        width,
        height,
      });
      return codec || null;
    } catch {
      return null;
    }
  }

  async exportFrame(
    file: File | Blob,
    timestamp: number,
    format: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
    quality: number = 0.8,
  ): Promise<Blob> {
    const frame = await this.getFrameAtTime(file, timestamp);
    if (!frame) {
      throw new Error("Could not extract frame");
    }

    const { canvas } = frame;
    let blob: Blob | null = null;

    if (canvas instanceof OffscreenCanvas) {
      blob = await canvas.convertToBlob({ type: format, quality });
    } else if (canvas instanceof HTMLCanvasElement) {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, format, quality),
      );
    } else if (canvas instanceof ImageBitmap) {
      const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
      const ctx = offscreen.getContext("2d");
      if (ctx) {
        ctx.drawImage(canvas, 0, 0);
        blob = await offscreen.convertToBlob({ type: format, quality });
      }
    }

    if (!blob) {
      throw new Error("Failed to create image blob");
    }

    return blob;
  }

  async generateProxy(
    file: File | Blob,
    onProgress?: (progress: ExportProgress) => void,
    signal?: AbortSignal,
  ): Promise<Blob> {
    // Proxy settings: 540p, lower bitrate, faster encoding
    const proxySettings: ExportSettings = {
      format: "mp4",
      height: 540,
      videoBitrate: 1_000_000, // 1 Mbps
      audioBitrate: 96_000, // 96 kbps
    };

    return this.convertMedia(file, proxySettings, onProgress, signal);
  }

  async exportImageSequence(
    file: File | Blob,
    startTime: number,
    endTime: number,
    frameRate: number,
    format: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
    quality: number = 0.8,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<Blob[]> {
    this.ensureInitialized();
    const { CanvasSink } = this.mediabunny!;
    const input = await this.createInput(file);

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw new Error("No video track found");
      }

      const canDecode = await videoTrack.canDecode();
      if (!canDecode) {
        throw new Error("Cannot decode video track");
      }

      const duration = endTime - startTime;
      const frameCount = Math.ceil(duration * frameRate);
      const timestamps = Array.from(
        { length: frameCount },
        (_, i) => startTime + i / frameRate,
      );

      const sink = new CanvasSink(videoTrack, {
        fit: "contain",
        poolSize: 5,
      });

      const blobs: Blob[] = [];
      let processed = 0;

      for await (const result of sink.canvasesAtTimestamps(timestamps)) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        if (result) {
          const { canvas } = result;
          let blob: Blob | null = null;
          if (canvas instanceof OffscreenCanvas) {
            blob = await canvas.convertToBlob({ type: format, quality });
          }

          if (blob) {
            blobs.push(blob);
          }
        }

        processed++;
        onProgress?.(processed / frameCount);
      }

      return blobs;
    } finally {
      input[Symbol.dispose]?.();
    }
  }

  async getBestAudioCodec(): Promise<string | null> {
    this.ensureInitialized();
    const { getFirstEncodableAudioCodec, Mp4OutputFormat } = this.mediabunny!;

    const format = new Mp4OutputFormat();
    const supportedCodecs = format.getSupportedAudioCodecs();

    try {
      const codec = await getFirstEncodableAudioCodec(supportedCodecs);
      return codec || null;
    } catch {
      return null;
    }
  }
}
let engineInstance: MediaBunnyEngine | null = null;

export function getMediaEngine(): MediaBunnyEngine {
  if (!engineInstance) {
    engineInstance = new MediaBunnyEngine();
  }
  return engineInstance;
}

export async function initializeMediaEngine(): Promise<MediaBunnyEngine> {
  const engine = getMediaEngine();
  await engine.initialize();
  return engine;
}
