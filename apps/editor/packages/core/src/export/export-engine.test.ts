import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockRenderFrame,
  mockVideoEngine,
  mockRenderAudio,
  mockAudioEngine,
  mockMediaEngine,
  mockVideoSourceAdd,
  mockAudioSourceAdd,
  mockVideoSourceConfigs,
  mockGetFirstEncodableVideoCodec,
  mockOutputStart,
  mockOutputFinalize,
} = vi.hoisted(() => {
  const mockRenderFrame = vi.fn().mockResolvedValue({
    image: { close: vi.fn() },
    width: 1920,
    height: 1080,
  });

  const mockVideoEngine = {
    isInitialized: vi.fn().mockReturnValue(false),
    initialize: vi.fn().mockResolvedValue(undefined),
    initializeGPUCompositor: vi.fn().mockResolvedValue(undefined),
    getGPUCompositor: vi.fn().mockReturnValue(null),
    renderFrame: mockRenderFrame,
    resetExportState: vi.fn(),
    clearVideoElementCache: vi.fn(),
    clearCache: vi.fn(),
  };

  const mockRenderAudio = vi.fn().mockResolvedValue({ buffer: null });
  const mockAudioEngine = {
    isInitialized: vi.fn().mockReturnValue(false),
    initialize: vi.fn().mockResolvedValue(undefined),
    renderAudio: mockRenderAudio,
    clearCache: vi.fn(),
  };

  const mockMediaEngine = {
    isAvailable: vi.fn().mockReturnValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    getExportDecoder: vi.fn().mockReturnValue(null),
    createExportDecoder: vi.fn().mockResolvedValue(null),
    disposeAllExportDecoders: vi.fn(),
    clearFrameCache: vi.fn(),
  };

  return {
    mockRenderFrame,
    mockVideoEngine,
    mockRenderAudio,
    mockAudioEngine,
    mockMediaEngine,
    mockVideoSourceAdd: vi.fn().mockResolvedValue(undefined),
    mockAudioSourceAdd: vi.fn().mockResolvedValue(undefined),
    mockVideoSourceConfigs: [] as Record<string, unknown>[],
    mockGetFirstEncodableVideoCodec: vi.fn().mockResolvedValue("avc"),
    mockOutputStart: vi.fn().mockResolvedValue(undefined),
    mockOutputFinalize: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../video/video-engine", () => ({
  VideoEngine: vi.fn(),
  getVideoEngine: vi.fn().mockReturnValue(mockVideoEngine),
}));

vi.mock("../audio/audio-engine", () => ({
  AudioEngine: vi.fn(),
  getAudioEngine: vi.fn().mockReturnValue(mockAudioEngine),
}));

vi.mock("../text/title-engine", () => ({
  titleEngine: {
    getAllTextClips: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../graphics/graphics-engine", () => ({
  graphicsEngine: {
    getAllShapeClips: vi.fn().mockReturnValue([]),
    getAllSVGClips: vi.fn().mockReturnValue([]),
    getAllStickerClips: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../media/mediabunny-engine", () => ({
  getMediaEngine: vi.fn().mockReturnValue(mockMediaEngine),
}));

vi.mock("mediabunny", () => {
  class MockMp4OutputFormat {
    getSupportedVideoCodecs() {
      return ["avc", "hevc"];
    }

    getSupportedAudioCodecs() {
      return ["aac"];
    }
  }

  class MockWebMOutputFormat extends MockMp4OutputFormat {}
  class MockMovOutputFormat extends MockMp4OutputFormat {}

  class MockOutput {
    addVideoTrack = vi.fn();
    addAudioTrack = vi.fn();
    setMetadataTags = vi.fn();
    start = mockOutputStart;
    finalize = mockOutputFinalize;
  }

  class MockStreamTarget {
    constructor(
      _writable: WritableStream<{ data: Uint8Array; position: number }>,
      _options?: Record<string, unknown>,
    ) {}
  }

  class MockVideoSampleSource {
    add = mockVideoSourceAdd;
    close = vi.fn();

    constructor(config: Record<string, unknown>) {
      mockVideoSourceConfigs.push(config);
    }
  }

  class MockAudioBufferSource {
    add = mockAudioSourceAdd;
    close = vi.fn();

    constructor(_config: Record<string, unknown>) {}
  }

  class MockVideoSample {
    close = vi.fn();

    constructor(
      _data: unknown,
      _init: { timestamp: number; duration: number },
    ) {}
  }

  return {
    Output: MockOutput,
    StreamTarget: MockStreamTarget,
    Mp4OutputFormat: MockMp4OutputFormat,
    WebMOutputFormat: MockWebMOutputFormat,
    MovOutputFormat: MockMovOutputFormat,
    VideoSampleSource: MockVideoSampleSource,
    AudioBufferSource: MockAudioBufferSource,
    VideoSample: MockVideoSample,
    getFirstEncodableVideoCodec: mockGetFirstEncodableVideoCodec,
    getFirstEncodableAudioCodec: vi.fn().mockResolvedValue("aac"),
    QUALITY_MEDIUM: 1_000_000,
  };
});

import { ExportEngine, getExportEngine } from "./export-engine";
import {
  DEFAULT_VIDEO_SETTINGS,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_IMAGE_SETTINGS,
  VIDEO_QUALITY_PRESETS,
} from "./types";
import type { Project, Timeline, Track, Clip } from "../types";

const createMockProject = (overrides?: Partial<Project>): Project => ({
  id: "test-project-id",
  name: "Test Project",
  createdAt: Date.now(),
  modifiedAt: Date.now(),
  settings: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    sampleRate: 48000,
    channels: 2,
  },
  mediaLibrary: {
    items: [
      {
        id: "media-1",
        name: "Mock video",
        type: "video",
        fileHandle: null,
        blob: null,
        metadata: {
          duration: 40,
          width: 1920,
          height: 1080,
          frameRate: 30,
          codec: "h264",
          sampleRate: 48_000,
          channels: 2,
          fileSize: 0,
          hasVideo: true,
          hasAudio: true,
        },
        thumbnailUrl: null,
        waveformData: null,
      },
    ],
  },
  timeline: {
    tracks: [],
    subtitles: [],
    duration: 0,
    markers: [],
  },
  ...overrides,
});

const createMockClip = (overrides?: Partial<Clip>): Clip => ({
  id: "clip-1",
  mediaId: "media-1",
  trackId: "track-1",
  startTime: 0,
  duration: 5,
  inPoint: 0,
  outPoint: 5,
  effects: [],
  audioEffects: [],
  transform: {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  },
  volume: 1,
  keyframes: [],
  ...overrides,
});

const createMockTrack = (overrides?: Partial<Track>): Track => ({
  id: "track-1",
  type: "video",
  name: "Video 1",
  clips: [createMockClip()],
  transitions: [],
  locked: false,
  hidden: false,
  muted: false,
  solo: false,
  ...overrides,
});

const createMockTimeline = (overrides?: Partial<Timeline>): Timeline => ({
  tracks: [createMockTrack()],
  subtitles: [],
  duration: 5,
  markers: [],
  ...overrides,
});

describe("ExportEngine", () => {
  let exportEngine: ExportEngine;

  beforeEach(() => {
    exportEngine = new ExportEngine();
    vi.clearAllMocks();
    mockVideoEngine.isInitialized.mockReturnValue(false);
    mockAudioEngine.isInitialized.mockReturnValue(false);
    mockMediaEngine.isAvailable.mockReturnValue(true);
    mockMediaEngine.getExportDecoder.mockReturnValue(null);
    mockVideoSourceConfigs.length = 0;
    mockGetFirstEncodableVideoCodec.mockResolvedValue("avc");
    mockRenderFrame.mockResolvedValue({
      image: { close: vi.fn() },
      width: 1920,
      height: 1080,
    });
    mockRenderAudio.mockResolvedValue({ buffer: null });
  });

  afterEach(() => {
    exportEngine.dispose();
  });

  describe("initialization", () => {
    it("should start uninitialized", () => {
      expect(exportEngine.isInitialized()).toBe(false);
    });

    it("should report MediaBunny unavailable before init", () => {
      expect(exportEngine.isMediaBunnyAvailable()).toBe(false);
    });
  });

  describe("singleton pattern", () => {
    it("should return same instance from getExportEngine", () => {
      const engine1 = getExportEngine();
      const engine2 = getExportEngine();
      expect(engine1).toBe(engine2);
    });
  });

  describe("presets", () => {
    it("should return export presets", () => {
      const presets = exportEngine.getPresets();
      expect(presets.length).toBeGreaterThan(0);
    });

    it("should have presets for all categories", () => {
      const presets = exportEngine.getPresets();
      const categories = new Set(presets.map((p) => p.category));
      expect(categories.has("social")).toBe(true);
      expect(categories.has("broadcast")).toBe(true);
      expect(categories.has("web")).toBe(true);
      expect(categories.has("archive")).toBe(true);
    });

    it("should have YouTube preset", () => {
      const presets = exportEngine.getPresets();
      const youtubePreset = presets.find((p) => p.id === "youtube-1080p");
      expect(youtubePreset).toBeDefined();
      expect(youtubePreset?.settings).toHaveProperty("codec", "h264");
    });

    it("should have TikTok preset with vertical dimensions", () => {
      const presets = exportEngine.getPresets();
      const tiktokPreset = presets.find((p) => p.id === "tiktok-1080p");
      expect(tiktokPreset).toBeDefined();
      if ("width" in tiktokPreset!.settings) {
        expect(tiktokPreset!.settings.width).toBe(1080);
        expect(tiktokPreset!.settings.height).toBe(1920);
      }
    });

    it("should create custom preset", () => {
      const customPreset = exportEngine.createPreset("My Preset", {
        ...DEFAULT_VIDEO_SETTINGS,
        bitrate: 15000,
      });
      expect(customPreset.name).toBe("My Preset");
      expect(customPreset.category).toBe("custom");
      expect(customPreset.id).toMatch(/^custom-/);
    });
  });

  describe("file size estimation", () => {
    it("should estimate video file size", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = { ...DEFAULT_VIDEO_SETTINGS, bitrate: 8000 };
      const estimatedSize = exportEngine.estimateFileSize(project, settings);

      const expectedSize = ((8000 * 1000 + 192 * 1000) * 60) / 8;
      expect(estimatedSize).toBe(Math.ceil(expectedSize));
    });

    it("should estimate audio file size for WAV", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = { ...DEFAULT_AUDIO_SETTINGS, format: "wav" as const };
      const estimatedSize = exportEngine.estimateFileSize(project, settings);

      const expectedSize = 60 * 48000 * 2 * (16 / 8);
      expect(estimatedSize).toBe(Math.ceil(expectedSize));
    });

    it("should estimate audio file size for MP3", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = { ...DEFAULT_AUDIO_SETTINGS, bitrate: 320 };
      const estimatedSize = exportEngine.estimateFileSize(project, settings);

      const expectedSize = (320 * 1000 * 60) / 8;
      expect(estimatedSize).toBe(Math.ceil(expectedSize));
    });
  });

  describe("export time estimation", () => {
    it("should estimate video export time", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const settings = DEFAULT_VIDEO_SETTINGS;
      const estimatedTime = exportEngine.estimateExportTime(project, settings);

      expect(estimatedTime).toBeGreaterThan(0);
    });

    it("should estimate longer time for H.265", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const h264Settings = {
        ...DEFAULT_VIDEO_SETTINGS,
        codec: "h264" as const,
      };
      const h265Settings = {
        ...DEFAULT_VIDEO_SETTINGS,
        codec: "h265" as const,
      };

      const h264Time = exportEngine.estimateExportTime(project, h264Settings);
      const h265Time = exportEngine.estimateExportTime(project, h265Settings);

      expect(h265Time).toBeGreaterThan(h264Time);
    });

    it("should estimate longer time for 4K", () => {
      const project = createMockProject({
        timeline: createMockTimeline({ duration: 60 }),
      });

      const hd = { ...DEFAULT_VIDEO_SETTINGS, width: 1920, height: 1080 };
      const fourK = { ...DEFAULT_VIDEO_SETTINGS, width: 3840, height: 2160 };

      const hdTime = exportEngine.estimateExportTime(project, hd);
      const fourKTime = exportEngine.estimateExportTime(project, fourK);

      expect(fourKTime).toBeGreaterThan(hdTime);
    });
  });

  describe("cancel", () => {
    it("should not throw when canceling without active export", () => {
      expect(() => exportEngine.cancel()).not.toThrow();
    });
  });

  describe("video export", () => {
    const writableStream = {
      seek: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileSystemWritableFileStream;

    async function drainVideoExport(
      settings = { ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360 },
    ): Promise<void> {
      const project = createMockProject({
        timeline: createMockTimeline({
          tracks: [
            createMockTrack({
              clips: [createMockClip({ duration: 1, outPoint: 1 })],
            }),
          ],
          duration: 1,
        }),
      });

      await exportEngine.initialize();
      const generator = exportEngine.exportVideo(project, settings, writableStream);

      while (true) {
        const { done } = await generator.next();
        if (done) break;
      }
    }

    it("should render long export audio in chunks and clear cached audio", async () => {
      const project = createMockProject({
        timeline: createMockTimeline({
          tracks: [
            createMockTrack({
              clips: [createMockClip({ duration: 40, outPoint: 40 })],
            }),
          ],
          duration: 40,
        }),
      });

      mockRenderAudio.mockResolvedValue({ buffer: { duration: 15 } });

      await exportEngine.initialize();

      const writableStream = {
        seek: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
      } as unknown as FileSystemWritableFileStream;

      const generator = exportEngine.exportVideo(
        project,
        { ...DEFAULT_VIDEO_SETTINGS, frameRate: 1, width: 640, height: 360 },
        writableStream,
      );

      while (true) {
        const { done } = await generator.next();
        if (done) break;
      }

      expect(mockRenderAudio).toHaveBeenCalledTimes(3);
      expect(mockRenderAudio).toHaveBeenNthCalledWith(1, project, 0, 15);
      expect(mockRenderAudio).toHaveBeenNthCalledWith(2, project, 15, 15);
      expect(mockRenderAudio).toHaveBeenNthCalledWith(3, project, 30, 10);
      expect(mockAudioSourceAdd).toHaveBeenCalledTimes(3);
      expect(mockAudioEngine.clearCache).toHaveBeenCalled();
    });

    it("prefers hardware WebCodecs for the default browser backend", async () => {
      mockGetFirstEncodableVideoCodec.mockImplementation(async (codecs) => codecs[0]);

      await drainVideoExport();

      expect(mockGetFirstEncodableVideoCodec).toHaveBeenCalledWith(
        ["avc", "hevc"],
        expect.objectContaining({ hardwareAcceleration: "prefer-hardware" }),
      );
      expect(mockVideoSourceConfigs[0]).toMatchObject({
        codec: "avc",
        hardwareAcceleration: "prefer-hardware",
      });
    });

    it("keeps decoder caches warm while throttling browser exports", async () => {
      await drainVideoExport({
        ...DEFAULT_VIDEO_SETTINGS,
        frameRate: 5,
        width: 640,
        height: 360,
      });

      // Caches are released once before muxing and once by the final safety
      // cleanup, but never in the middle of the five-frame render loop.
      expect(mockVideoEngine.clearVideoElementCache).toHaveBeenCalledTimes(2);
      expect(mockVideoEngine.clearCache).toHaveBeenCalledTimes(2);
      expect(mockMediaEngine.clearFrameCache).toHaveBeenCalledTimes(2);
    });

    it("falls back to no-preference when hardware WebCodecs is unavailable", async () => {
      mockGetFirstEncodableVideoCodec.mockImplementation(async (_codecs, options) =>
        options.hardwareAcceleration === "prefer-hardware" ? null : "avc",
      );

      await drainVideoExport();

      expect(mockGetFirstEncodableVideoCodec).toHaveBeenNthCalledWith(
        1,
        ["avc", "hevc"],
        expect.objectContaining({ hardwareAcceleration: "prefer-hardware" }),
      );
      expect(mockGetFirstEncodableVideoCodec).toHaveBeenNthCalledWith(
        2,
        ["avc", "hevc"],
        expect.objectContaining({ hardwareAcceleration: "no-preference" }),
      );
      expect(mockVideoSourceConfigs[0]).toMatchObject({
        codec: "avc",
        hardwareAcceleration: "no-preference",
      });
    });

    it("tries the requested codec before other container codecs", async () => {
      mockGetFirstEncodableVideoCodec.mockImplementation(async (codecs) => codecs[0]);

      await drainVideoExport({
        ...DEFAULT_VIDEO_SETTINGS,
        codec: "h265",
        frameRate: 1,
        width: 640,
        height: 360,
      });

      expect(mockGetFirstEncodableVideoCodec).toHaveBeenCalledWith(
        ["hevc", "avc"],
        expect.objectContaining({ hardwareAcceleration: "prefer-hardware" }),
      );
      expect(mockVideoSourceConfigs[0]).toMatchObject({
        codec: "hevc",
      });
    });
  });

  describe("dispose", () => {
    it("should reset state on dispose", () => {
      exportEngine.dispose();
      expect(exportEngine.isInitialized()).toBe(false);
      expect(exportEngine.isMediaBunnyAvailable()).toBe(false);
    });
  });
});

describe("Export Types and Defaults", () => {
  describe("DEFAULT_VIDEO_SETTINGS", () => {
    it("should have correct default format", () => {
      expect(DEFAULT_VIDEO_SETTINGS.format).toBe("mp4");
    });

    it("should have correct default codec", () => {
      expect(DEFAULT_VIDEO_SETTINGS.codec).toBe("h264");
    });

    it("should have correct default resolution", () => {
      expect(DEFAULT_VIDEO_SETTINGS.width).toBe(1920);
      expect(DEFAULT_VIDEO_SETTINGS.height).toBe(1080);
    });

    it("should have correct default frame rate", () => {
      expect(DEFAULT_VIDEO_SETTINGS.frameRate).toBe(30);
    });

    it("should have audio settings", () => {
      expect(DEFAULT_VIDEO_SETTINGS.audioSettings).toBeDefined();
      expect(DEFAULT_VIDEO_SETTINGS.audioSettings.sampleRate).toBe(48000);
    });
  });

  describe("DEFAULT_AUDIO_SETTINGS", () => {
    it("should have correct defaults", () => {
      expect(DEFAULT_AUDIO_SETTINGS.format).toBe("mp3");
      expect(DEFAULT_AUDIO_SETTINGS.sampleRate).toBe(48000);
      expect(DEFAULT_AUDIO_SETTINGS.bitrate).toBe(320);
      expect(DEFAULT_AUDIO_SETTINGS.channels).toBe(2);
    });
  });

  describe("DEFAULT_IMAGE_SETTINGS", () => {
    it("should have correct defaults", () => {
      expect(DEFAULT_IMAGE_SETTINGS.format).toBe("jpg");
      expect(DEFAULT_IMAGE_SETTINGS.quality).toBe(90);
      expect(DEFAULT_IMAGE_SETTINGS.width).toBe(1920);
      expect(DEFAULT_IMAGE_SETTINGS.height).toBe(1080);
    });
  });

  describe("VIDEO_QUALITY_PRESETS", () => {
    it("should have 4K preset", () => {
      expect(VIDEO_QUALITY_PRESETS["4k"]).toBeDefined();
      expect(VIDEO_QUALITY_PRESETS["4k"].width).toBe(3840);
      expect(VIDEO_QUALITY_PRESETS["4k"].height).toBe(2160);
    });

    it("should have 1080p preset", () => {
      expect(VIDEO_QUALITY_PRESETS["1080p"]).toBeDefined();
      expect(VIDEO_QUALITY_PRESETS["1080p"].width).toBe(1920);
      expect(VIDEO_QUALITY_PRESETS["1080p"].height).toBe(1080);
    });

    it("should have 720p preset", () => {
      expect(VIDEO_QUALITY_PRESETS["720p"]).toBeDefined();
      expect(VIDEO_QUALITY_PRESETS["720p"].width).toBe(1280);
      expect(VIDEO_QUALITY_PRESETS["720p"].height).toBe(720);
    });

    it("should have higher bitrate for 4K than 1080p", () => {
      expect(VIDEO_QUALITY_PRESETS["4k"].bitrate).toBeGreaterThan(
        VIDEO_QUALITY_PRESETS["1080p"].bitrate,
      );
    });
  });
});

/**
 * Audio chunks must together span the whole timeline, whatever the audio track looks like.
 *
 * An agent report claimed a 15s chunk with no content was skipped rather than written as
 * silence, shifting all later audio earlier. That was false: `renderAudio` sizes an
 * OfflineAudioContext to the entire requested window, so an empty window already comes back
 * as a full-length silent buffer, and three real exports with gaps landed their tones at the
 * right timestamps. See Stage 21 in NOTES.md.
 *
 * The mechanism was wrong but the failure mode is worth guarding: a later "skip chunks with
 * no content" optimisation would reintroduce exactly the reported shift. These tests drive the
 * chunk loop with an audio engine that returns `{ buffer: null }` for empty windows — the
 * shape such an optimisation would produce — and require the writes to still cover the
 * timeline.
 */
describe("ExportEngine audio chunk continuity", () => {
  const SAMPLE_RATE = 48_000;

  let engine: ExportEngine;
  let written: number[];
  let backend: { addAudioBuffer: (buffer: AudioBuffer) => Promise<void> };

  /** A minimal stand-in: only length and sampleRate are read back. */
  function fakeBuffer(seconds: number): AudioBuffer {
    return {
      length: Math.max(1, Math.ceil(seconds * SAMPLE_RATE)),
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
      duration: seconds,
    } as unknown as AudioBuffer;
  }

  beforeEach(async () => {
    // createSilentAudioBuffer uses the real AudioBuffer constructor, which the node test
    // environment does not provide.
    vi.stubGlobal(
      "AudioBuffer",
      class {
        length: number;
        sampleRate: number;
        numberOfChannels: number;
        constructor(options: { length: number; sampleRate: number; numberOfChannels: number }) {
          this.length = options.length;
          this.sampleRate = options.sampleRate;
          this.numberOfChannels = options.numberOfChannels;
        }
      },
    );
    engine = new ExportEngine();
    // audioEngine is only wired up by initialize(); without it the chunk loop throws.
    await engine.initialize();
    written = [];
    backend = {
      addAudioBuffer: vi.fn(async (buffer: AudioBuffer) => {
        written.push(buffer.length / buffer.sampleRate);
      }),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function projectWithAudio(timelineDuration: number, hasAudio = true) {
    const base = createMockProject();
    const item = base.mediaLibrary.items[0]!;
    // Built rather than mutated: MediaItem.metadata is readonly.
    return createMockProject({
      mediaLibrary: {
        items: [{ ...item, metadata: { ...item.metadata, hasAudio } }],
      },
      timeline: createMockTimeline({
        tracks: [
          createMockTrack({
            clips: [createMockClip({ duration: timelineDuration, outPoint: timelineDuration })],
          }),
        ],
        duration: timelineDuration,
      }),
    });
  }

  /** Returns a buffer only for windows overlapping [audioStart, audioEnd). */
  function onlyCoverRange(audioStart: number, audioEnd: number) {
    mockRenderAudio.mockImplementation(
      async (_project: Project, startTime: number, duration: number) => {
        const overlaps = startTime < audioEnd && startTime + duration > audioStart;
        return { buffer: overlaps ? fakeBuffer(duration) : null };
      },
    );
  }

  async function encode(project: Project) {
    await (
      engine as unknown as {
        encodeTimelineAudioToBackend: (p: Project, b: unknown) => Promise<void>;
      }
    ).encodeTimelineAudioToBackend(project, backend);
    return written.reduce((total, seconds) => total + seconds, 0);
  }

  it.each([
    ["a gap covering a whole chunk", 45, 0, 10],
    ["a gap at the start", 45, 20, 30],
    ["three empty leading chunks", 60, 50, 60],
    ["audio shorter than the timeline", 45, 0, 5],
    ["audio ending exactly on a chunk boundary", 45, 0, 15],
    ["audio starting exactly on a chunk boundary", 45, 15, 25],
    ["full coverage", 45, 0, 45],
  ])("covers the timeline with %s", async (_label, timelineDuration, audioStart, audioEnd) => {
    const project = projectWithAudio(timelineDuration);
    onlyCoverRange(audioStart, audioEnd);

    const total = await encode(project);

    // Within a sample: chunk lengths are ceil()ed to whole samples.
    expect(total).toBeCloseTo(timelineDuration, 3);
    expect(written).toHaveLength(Math.ceil(timelineDuration / 15));
  });

  it("writes silence for empty chunks instead of skipping them", async () => {
    // 60s timeline, audio only in the last 10s: the first three chunks are entirely empty.
    const project = projectWithAudio(60);
    onlyCoverRange(50, 60);

    await encode(project);

    expect(written).toHaveLength(4);
    for (const seconds of written.slice(0, 3)) {
      expect(seconds).toBeCloseTo(15, 3);
    }
  });

  it("still writes no audio at all when the project has none", async () => {
    // The one case that must keep skipping: a silent project gets no audio track. That is
    // why the project-level check sits before the loop rather than inside it.
    const project = projectWithAudio(45, false);
    onlyCoverRange(0, 0);

    const total = await encode(project);

    expect(total).toBe(0);
    expect(backend.addAudioBuffer).not.toHaveBeenCalled();
  });
});
