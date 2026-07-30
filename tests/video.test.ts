import { describe, expect, it } from 'vitest';
import type { AudioPlan, EditPlan, MotionCue, VideoEnhancePlan } from '@/lib/types';
import {
  LabelAllocator,
  buildAudioFilters,
  buildEncoderArgs,
  buildEnhanceFilters,
  buildKeyframeExpression,
  buildMotionFilter,
  buildReframeFilter,
  buildScaleFilters,
  buildTrimConcat,
  buildZoomExpression,
  dbToLinear,
  decomposeTempo,
  escapeFilterPath,
  renderGraph,
  renderNode,
} from '@/server/video/filtergraph';
import { buildAnalysisCommand, buildRenderCommand, buildThumbnailCommand } from '@/server/video/render';
import { parseFrameRate, parseProbe, parseProgress, probeArgs } from '@/server/video/ffmpeg';
import { EXPORT_PRESETS, getPreset, presetsForAspect } from '@/server/video/presets';
import { buildEditPlan } from '@/server/edit/plan';
import { buildMockTranscript } from '@/server/ai/providers/mock';

const PRESET = getPreset('vertical-1080')!;

function planFixture(): EditPlan {
  const transcript = buildMockTranscript('render-fixture');
  return buildEditPlan({
    probe: {
      durationSec: transcript.durationSec,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      audioChannels: 2,
      audioSampleRate: 48000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrateKbps: 6000,
    },
    transcript,
  });
}

describe('filter graph primitives', () => {
  it('renders a node with inputs, args and outputs', () => {
    expect(
      renderNode({
        filter: 'crop',
        args: { w: 608, h: 1080, x: 100, y: 0 },
        inputs: ['0:v'],
        outputs: ['v1'],
      }),
    ).toBe('[0:v]crop=w=608:h=1080:x=100:y=0[v1]');
  });

  it('omits undefined and empty arguments', () => {
    expect(
      renderNode({ filter: 'subtitles', args: { filename: 'a.ass', fontsdir: undefined }, inputs: ['v'], outputs: ['o'] }),
    ).toBe('[v]subtitles=filename=a.ass[o]');
  });

  it('joins nodes with semicolons', () => {
    const graph = renderGraph([
      { filter: 'a', inputs: ['0:v'], outputs: ['x'] },
      { filter: 'b', inputs: ['x'], outputs: ['y'] },
    ]);
    expect(graph).toBe('[0:v]a[x];[x]b[y]');
  });

  it('allocates unique labels', () => {
    const labels = new LabelAllocator();
    const generated = [labels.next('v'), labels.next('v'), labels.next('a')];
    expect(new Set(generated).size).toBe(3);
  });

  it('escapes filter paths so a colon cannot break the argument', () => {
    expect(escapeFilterPath('C:/media/a.ass')).toBe('C\\\\:/media/a.ass');
  });
});

describe('tempo decomposition', () => {
  it('returns nothing for 1x', () => {
    expect(decomposeTempo(1)).toEqual([]);
    expect(decomposeTempo(1.0005)).toEqual([]);
  });

  it('passes an in-range factor straight through', () => {
    expect(decomposeTempo(1.1)).toEqual([1.1]);
  });

  it('splits an out-of-range factor into a chain whose product matches', () => {
    for (const speed of [4, 0.25, 3.3, 0.4]) {
      const chain = decomposeTempo(speed);
      expect(chain.every((factor) => factor >= 0.5 && factor <= 2)).toBe(true);
      expect(chain.reduce((a, b) => a * b, 1)).toBeCloseTo(speed, 3);
    }
  });
});

describe('trim & concat', () => {
  it('skips the graph entirely for an untouched full-length clip', () => {
    const plan = planFixture();
    plan.cutPlan.kept = [
      { sourceStart: 0, sourceEnd: plan.sourceDurationSec, outputStart: 0, speed: 1 },
    ];

    const result = buildTrimConcat(plan, new LabelAllocator(), {
      videoInput: '0:v',
      audioInput: '0:a',
      hasAudio: true,
    });

    expect(result.nodes).toHaveLength(0);
    expect(result.videoOut).toBe('0:v');
  });

  it('emits a trim/setpts pair per segment and one concat', () => {
    const plan = planFixture();
    plan.cutPlan.kept = [
      { sourceStart: 0, sourceEnd: 2, outputStart: 0, speed: 1 },
      { sourceStart: 5, sourceEnd: 8, outputStart: 2, speed: 1 },
    ];

    const result = buildTrimConcat(plan, new LabelAllocator(), {
      videoInput: '0:v',
      audioInput: '0:a',
      hasAudio: true,
    });

    const graph = renderGraph(result.nodes);
    // `(?<!a)` so the video count does not also match `atrim=`.
    expect((graph.match(/(?<!a)trim=/g) ?? []).length).toBe(2);
    expect((graph.match(/atrim=/g) ?? []).length).toBe(2);
    expect(graph).toContain('concat=n=2:v=1:a=1');
  });

  it('applies atempo when a segment is retimed', () => {
    const plan = planFixture();
    plan.cutPlan.kept = [{ sourceStart: 0, sourceEnd: 4, outputStart: 0, speed: 1.1 }];

    const graph = renderGraph(
      buildTrimConcat(plan, new LabelAllocator(), {
        videoInput: '0:v',
        audioInput: '0:a',
        hasAudio: true,
      }).nodes,
    );

    expect(graph).toContain('atempo=1.1');
    expect(graph).toContain('setpts=(PTS-STARTPTS)/1.1');
  });

  it('produces a video-only concat when there is no audio track', () => {
    const plan = planFixture();
    plan.cutPlan.kept = [
      { sourceStart: 0, sourceEnd: 2, outputStart: 0, speed: 1 },
      { sourceStart: 4, sourceEnd: 6, outputStart: 2, speed: 1 },
    ];

    const result = buildTrimConcat(plan, new LabelAllocator(), {
      videoInput: '0:v',
      audioInput: '0:a',
      hasAudio: false,
    });

    expect(result.audioOut).toBeNull();
    expect(renderGraph(result.nodes)).toContain('concat=n=2:v=1:a=0');
  });

  it('consumes every label it produces exactly once', () => {
    const plan = planFixture();
    plan.cutPlan.kept = [
      { sourceStart: 0, sourceEnd: 2, outputStart: 0, speed: 1 },
      { sourceStart: 3, sourceEnd: 6, outputStart: 2, speed: 1.05 },
    ];

    const result = buildTrimConcat(plan, new LabelAllocator(), {
      videoInput: '0:v',
      audioInput: '0:a',
      hasAudio: true,
    });

    const produced = new Set(result.nodes.flatMap((node) => node.outputs));
    const consumed = new Set(result.nodes.flatMap((node) => node.inputs));

    for (const label of produced) {
      // Every intermediate is consumed; only the two final outputs are not.
      if (label === result.videoOut || label === result.audioOut) continue;
      expect(consumed.has(label)).toBe(true);
    }
  });
});

describe('keyframe expressions', () => {
  it('collapses a single keyframe to a constant', () => {
    expect(buildKeyframeExpression([{ time: 0, x: 100, y: 0, width: 608, height: 1080 }], (f) => f.x)).toBe('100');
  });

  it('interpolates linearly between keyframes', () => {
    const expression = buildKeyframeExpression(
      [
        { time: 0, x: 0, y: 0, width: 608, height: 1080 },
        { time: 2, x: 200, y: 0, width: 608, height: 1080 },
      ],
      (frame) => frame.x,
    );

    expect(expression).toContain('if(lt(t,2)');
    expect(expression).toContain('(0+(200)*(t-0)/2)');
  });

  it('emits a constant for a segment where the value does not change', () => {
    const expression = buildKeyframeExpression(
      [
        { time: 0, x: 100, y: 0, width: 608, height: 1080 },
        { time: 2, x: 100, y: 0, width: 608, height: 1080 },
      ],
      (frame) => frame.x,
    );
    expect(expression).not.toContain('*(t-');
  });

  it('uses a plain crop for a static reframe plan', () => {
    const result = buildReframeFilter(
      {
        targetAspect: 9 / 16,
        sourceWidth: 1920,
        sourceHeight: 1080,
        isStaticFallback: true,
        keyframes: [{ time: 0, x: 656, y: 0, width: 608, height: 1080 }],
      },
      new LabelAllocator(),
      'v0',
    );

    expect(renderGraph(result.nodes)).toBe('[v0]crop=w=608:h=1080:x=656:y=0[vcrop1]');
  });
});

describe('motion', () => {
  it('is a no-op with no cues', () => {
    const result = buildMotionFilter([], PRESET, new LabelAllocator(), 'v0');
    expect(result.nodes).toHaveLength(0);
    expect(result.output).toBe('v0');
  });

  it('scales up then crops back to the exact output size', () => {
    const cues: MotionCue[] = [
      { start: 0, end: 4, kind: 'zoom-in', intensity: 1.08, reason: 'test' },
    ];
    const graph = renderGraph(buildMotionFilter(cues, PRESET, new LabelAllocator(), 'v0').nodes);

    expect(graph).toContain('scale=');
    expect(graph).toContain(`crop=w=${PRESET.width}:h=${PRESET.height}`);
    // Even dimensions are required by the encoder.
    expect(graph).toContain('trunc(');
  });

  it('returns 1 outside every cue', () => {
    const expression = buildZoomExpression([
      { start: 2, end: 4, kind: 'zoom-in', intensity: 1.1, reason: '' },
    ]);
    expect(expression).toContain('between(t,2,4)');
    expect(expression.endsWith(',1)')).toBe(true);
  });
});

describe('enhancement and scaling', () => {
  it('orders denoise before sharpen', () => {
    const plan: VideoEnhancePlan = {
      denoise: true,
      sharpen: 0.5,
      saturation: 1,
      contrast: 1,
      brightness: 0,
      upscaleTo: null,
      notes: [],
    };
    const graph = renderGraph(buildEnhanceFilters(plan, new LabelAllocator(), 'v0').nodes);
    expect(graph.indexOf('hqdn3d')).toBeLessThan(graph.indexOf('unsharp'));
  });

  it('emits nothing when there is nothing to do', () => {
    const plan: VideoEnhancePlan = {
      denoise: false,
      sharpen: 0,
      saturation: 1,
      contrast: 1,
      brightness: 0,
      upscaleTo: null,
      notes: [],
    };
    expect(buildEnhanceFilters(plan, new LabelAllocator(), 'v0').nodes).toHaveLength(0);
  });

  it('scales without distortion and pads the remainder', () => {
    const graph = renderGraph(buildScaleFilters(PRESET, new LabelAllocator(), 'v0').nodes);
    expect(graph).toContain('force_original_aspect_ratio=decrease');
    expect(graph).toContain('pad=w=1080:h=1920');
  });
});

describe('audio chain', () => {
  const plan: AudioPlan = {
    denoise: true,
    denoiseStrength: 12,
    targetLufs: -14,
    targetTruePeakDb: -1,
    loudnessRangeLu: 11,
    deEss: true,
    highPassHz: 80,
    compressorRatio: 2.5,
    notes: [],
  };

  it('applies the broadcast chain in order', () => {
    const graph = renderGraph(buildAudioFilters(plan, new LabelAllocator(), 'a0').nodes);
    const order = ['highpass', 'afftdn', 'deesser', 'acompressor', 'loudnorm', 'alimiter'];

    let cursor = -1;
    for (const filter of order) {
      const index = graph.indexOf(filter);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('always normalises and limits, even with everything else disabled', () => {
    const minimal: AudioPlan = {
      ...plan,
      denoise: false,
      deEss: false,
      highPassHz: null,
      compressorRatio: null,
    };
    const graph = renderGraph(buildAudioFilters(minimal, new LabelAllocator(), 'a0').nodes);

    expect(graph).toContain('loudnorm=I=-14');
    expect(graph).toContain('alimiter');
    expect(graph).not.toContain('afftdn');
  });

  it('converts dBFS to a linear limiter ceiling', () => {
    expect(dbToLinear(0)).toBeCloseTo(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
  });
});

describe('encoder arguments', () => {
  it('uses a universally decodable pixel format', () => {
    expect(buildEncoderArgs(PRESET)).toContain('yuv420p');
  });

  it('front-loads the mp4 index for streaming', () => {
    const args = buildEncoderArgs(PRESET);
    expect(args).toContain('-movflags');
    expect(args).toContain('+faststart');
  });

  it('selects opus for webm and aac for mp4', () => {
    expect(buildEncoderArgs(getPreset('vertical-webm')!)).toContain('libopus');
    expect(buildEncoderArgs(PRESET)).toContain('aac');
  });

  it('sets a two-second GOP', () => {
    const args = buildEncoderArgs(PRESET);
    expect(args[args.indexOf('-g') + 1]).toBe(String(PRESET.fps * 2));
  });
});

describe('render command', () => {
  it('maps the final labels and writes progress to stdout', () => {
    const command = buildRenderCommand({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      plan: planFixture(),
      preset: PRESET,
      hasAudio: true,
    });

    expect(command.args).toContain('-filter_complex');
    expect(command.args).toContain('-progress');
    expect(command.args[command.args.length - 1]).toBe('/tmp/out.mp4');
    expect(command.args.some((arg) => arg.startsWith('['))).toBe(true);
  });

  it('never interpolates the input path into the filter graph', () => {
    const command = buildRenderCommand({
      inputPath: "/tmp/evil';rm -rf /.mp4",
      outputPath: '/tmp/out.mp4',
      plan: planFixture(),
      preset: PRESET,
      hasAudio: true,
    });
    expect(command.filterGraph).not.toContain('rm -rf');
  });

  it('adds the music input and -shortest when a bed is selected', () => {
    const plan = planFixture();
    plan.music = {
      trackId: 'trk_dusk',
      title: 'Dusk Drive',
      license: 'CC0-1.0',
      startAt: 0,
      gainDb: -18,
      duckDb: -8,
      fadeInSec: 0.8,
      fadeOutSec: 1.2,
    };

    const command = buildRenderCommand({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      plan,
      preset: PRESET,
      musicPath: '/tmp/music.mp3',
      hasAudio: true,
    });

    expect(command.args).toContain('-stream_loop');
    expect(command.args).toContain('-shortest');
    expect(command.filterGraph).toContain('sidechaincompress');
  });

  it('burns in subtitles after scaling so text is never resampled', () => {
    const plan = planFixture();
    const command = buildRenderCommand({
      inputPath: '/tmp/in.mp4',
      outputPath: '/tmp/out.mp4',
      plan,
      preset: PRESET,
      subtitlePath: '/tmp/captions.ass',
      hasAudio: true,
    });

    expect(command.filterGraph.indexOf('scale=')).toBeLessThan(
      command.filterGraph.indexOf('subtitles='),
    );
  });

  it('builds a thumbnail command that crops to fill', () => {
    const args = buildThumbnailCommand('/tmp/in.mp4', '/tmp/out.jpg', 3, { width: 640, height: 1138 });
    expect(args).toContain('-frames:v');
    expect(args.join(' ')).toContain('crop=640:1138');
  });

  it('measures loudness and the envelope in a single pass', () => {
    const args = buildAnalysisCommand('/tmp/in.mp4');
    const filters = args[args.indexOf('-af') + 1]!;
    expect(filters).toContain('astats');
    expect(filters).toContain('loudnorm');
  });
});

describe('ffprobe parsing', () => {
  it('parses rational frame rates', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('0/0')).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
  });

  it('parses a full probe payload', () => {
    const probe = parseProbe(
      JSON.stringify({
        format: { duration: '61.5', bit_rate: '5000000' },
        streams: [
          { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1', codec_name: 'h264' },
          { codec_type: 'audio', channels: 2, sample_rate: '48000', codec_name: 'aac' },
        ],
      }),
    );

    expect(probe.durationSec).toBe(61.5);
    expect(probe.width).toBe(1920);
    expect(probe.fps).toBe(30);
    expect(probe.hasAudio).toBe(true);
    expect(probe.bitrateKbps).toBe(5000);
  });

  it('handles an audio-only file with no video stream', () => {
    const probe = parseProbe(
      JSON.stringify({
        format: { duration: '30' },
        streams: [{ codec_type: 'audio', channels: 1, sample_rate: '44100', codec_name: 'mp3' }],
      }),
    );

    expect(probe.width).toBe(0);
    expect(probe.hasAudio).toBe(true);
    expect(probe.videoCodec).toBeNull();
  });

  it('requests JSON output when probing', () => {
    expect(probeArgs('/tmp/a.mp4')).toContain('-print_format');
  });

  it('parses a progress block', () => {
    const parsed = parseProgress('frame=120\nfps=30\nout_time_ms=4000000\nprogress=continue\n');
    expect(parsed).not.toBeNull();
    expect(parsed!['out_time_ms']).toBe('4000000');
  });
});

describe('export presets', () => {
  it('ships every aspect ratio the platforms need', () => {
    for (const aspect of ['9:16', '1:1', '4:5', '16:9'] as const) {
      expect(presetsForAspect(aspect).length).toBeGreaterThan(0);
    }
  });

  it('uses even dimensions everywhere', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(preset.width % 2).toBe(0);
      expect(preset.height % 2).toBe(0);
    }
  });

  it('matches each preset label to its declared aspect', () => {
    for (const preset of EXPORT_PRESETS) {
      const ratio = preset.width / preset.height;
      const expected = { '9:16': 9 / 16, '1:1': 1, '4:5': 0.8, '16:9': 16 / 9 }[preset.aspect];
      expect(Math.abs(ratio - expected)).toBeLessThan
        (0.01);
    }
  });
});
