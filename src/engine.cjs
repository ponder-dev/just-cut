'use strict';

/*
 * Turning an edit into one ffmpeg run.
 *
 * Knows nothing about Electron, so the whole export path can be driven from a
 * plain node script and the CLI can exist at all. main.cjs and cli.cjs supply
 * the binary paths and turn the callbacks into IPC or a progress bar.
 *
 * The file is split along the only line that matters for testing:
 *
 *   buildRender()  pure. No spawn, no fs, no await. Given a project and the
 *                  measurements taken from its source files, it returns the
 *                  exact ffmpeg argument list. Every timeline decision the app
 *                  makes lives in here, which is why it is worth pinning down
 *                  with golden tests rather than watching a preview and hoping.
 *
 *   probe()        impure. Reads the source files.
 *   render()       impure. Probes are already done; this spawns and renames.
 *
 * The original this was ported from awaited three probes in the middle of
 * graph assembly, which made the graph untestable for the sake of about six
 * lines. Everything else in it was already deterministic string work.
 *
 * Sources are only ever read. The one path this writes to is the one the
 * caller asked for, and even that is written beside itself first and renamed
 * into place, so an interrupted export cannot leave a half file where a good
 * one was.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const plan = require('./plan.js');

/*
 * Audio, and the line this tool will not cross.
 *
 * Just Cut moves audio around. It trims it, retimes it with atempo, joins it,
 * crossfades it, and invents silence for a clip that has no sound at all,
 * because you cannot cut a video without cutting its audio. All of that is
 * structure, and structure is this tool's job.
 *
 * What it does not do is change how the audio sounds. No loudness pass, no
 * repair of a clip recorded onto one channel, nothing that makes the sound
 * coming out different in kind from the sound going in. That work lives in
 * Just Sound. These tools take a video and give back a video, so a cut is
 * handed straight on to it rather than needing a feature here.
 *
 * Just Cut used to carry a loudness pass and a channel repair of its own,
 * which meant two implementations of one thing that had to agree with each
 * other forever. This is the copy that went.
 *
 * The one filter below is conforming rather than treating: every clip is
 * resampled to a single rate and layout before it is joined, because mixing
 * rates or layouts into concat produces silence on the odd clip rather than an
 * error, which is the worst way to find out.
 */
const AUDIO_RATE = 48000;
const AUDIO_CONFORM = `aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

const DEFAULTS = { crf: 19, preset: 'fast', audioKbps: 192, lossless: false };

/*
 * The two ways out.
 *
 * The normal export is a delivery file: H.264 at a quality nobody can tell from
 * the source, AAC sound, plays anywhere.
 *
 * lossless is for a step in the middle of a chain (CONTRACT.md section 6), so
 * a five step workflow loses quality once rather than five times. Same
 * container, same codec, same pixel format, so whatever reads it next needs
 * nothing new: x264 at -qp 0 is mathematically lossless for the frames it is
 * given, and ALAC is lossless sound that MP4 has carried for years, where PCM
 * in MP4 is too new for many readers. The cost is size, often ten times the
 * normal file, and some players will not open it. It is an intermediate, not
 * something to send anyone.
 */
function codecArgs(o) {
  if (o.lossless) {
    return ['-c:v', 'libx264', '-preset', o.preset, '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'alac'];
  }
  return [
    '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${o.audioKbps}k`,
  ];
}

/*
 * A handle the caller can cancel through.
 *
 * Every process an export starts (the measuring passes as well as the encode)
 * is held here, so a cancel ends whichever is running, whenever it comes.
 * They are ended with SIGKILL, not the default SIGTERM: ffmpeg answers a
 * SIGTERM by finishing the stream it is on, which on a long clip kept an
 * encode going for ten seconds after Cancel, and the window with it. A killed
 * encode has nothing worth keeping, so there is nothing to finish for.
 */
function control() {
  return {
    child: null,
    children: new Set(),
    cancelled: false,
    cancel() {
      this.cancelled = true;
      for (const c of this.children) c.kill('SIGKILL');
    },
  };
}

const cancelledError = () => Object.assign(new Error('Cancelled'), { cancelled: true });

// Seconds are written to milliseconds everywhere. ffmpeg parses more, but three
// places is below a frame at any sane rate and it keeps the graph readable when
// something goes wrong and you have to read it.
const t = (n) => Number(n).toFixed(3);

/*
 * The frame rate of the export.
 *
 * The highest rate in the timeline, so a 60fps clip is not thrown away just
 * because it sits next to a 30fps one. Going the other way costs nothing but
 * file size; going down is destructive and cannot be undone later.
 */
function targetFps(measurements, opts = {}) {
  if (opts.fps) return opts.fps;
  const rates = (measurements.clips || [])
    .map((m) => Number(m && m.fps))
    .filter((f) => Number.isFinite(f) && f > 0);
  if (!rates.length) return 30;
  // Kept to three places rather than rounded to a whole number, because 29.97
  // forced to 30 duplicates a frame every half minute.
  return Math.round(Math.max(...rates) * 1000) / 1000;
}

/*
 * PURE. Project plus measurements in, ffmpeg arguments out.
 *
 * The returned args deliberately stop short of the destination path: render()
 * appends the temp file it is about to write. That keeps this function free of
 * anything to do with the filesystem, and means a golden test can assert the
 * entire command apart from one path that changes every run.
 */
function buildRender(project, measurements, opts = {}) {
  const clips = (project && project.clips) || [];
  if (!clips.length) throw new Error('There is nothing on the timeline yet');

  const sizes = (measurements && measurements.clips) || [];
  const o = { ...DEFAULTS, ...opts };

  // The frame is sized off the first clip, because that is the shot the edit
  // opens on and the one a person has in mind when they pick a shape. Later
  // clips are scaled and cropped to match it.
  const first = sizes[0] || {};
  const target = plan.targetSize(project.format, first.width, first.height);
  const W = target.width;
  const H = target.height;
  const FPS = targetFps(measurements, o);

  const pan = (project && project.pan) || {};
  const panX = Number.isFinite(pan.x) ? pan.x : 0.5;
  const panY = Number.isFinite(pan.y) ? pan.y : 0.5;

  /*
   * Where every clip lands in the finished video.
   *
   * Taken from plan.js rather than accumulated here, because an xfade offset
   * and the position plan.js reports for the same clip have to be the same
   * number. Two places counting the same timeline is how a progress bar starts
   * lying and an export comes out truncated.
   */
  const starts = plan.clipStarts(clips);
  const totalDur = plan.totalDuration(clips);

  const inputArgs = [];
  for (const c of clips) inputArgs.push('-i', c.src);

  const F = [];

  clips.forEach((c, i) => {
    const m = sizes[i] || {};
    // Number(), because a project read from JSON may carry "2" as text.
    const speed = Number(c.speed) || 1;

    /*
     * Trim, then retime, then conform.
     *
     * The scale/crop pair is applied even when the format is 'source' and the
     * numbers come out identical. Concat and xfade both refuse clips of
     * differing size or aspect, and a timeline made of footage from one phone
     * and one camera is the normal case, not the exotic one.
     *
     * force_original_aspect_ratio=increase fills the target and overflows,
     * then crop takes the frame back down. The crop offset is left as an
     * ffmpeg expression rather than a computed number because the scaled size
     * is not known until the filter runs.
     *
     * settb=AVTB puts every clip on the timebase concat hands on. xfade
     * refuses two inputs whose timebases differ, so without it a fade that
     * follows a cut wrote nothing at all.
     */
    F.push(
      `[${i}:v]trim=start=${t(c.in)}:end=${t(c.out)},` +
      `setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=${FPS},` +
      `scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H}:x='(iw-ow)*${panX.toFixed(3)}':y='(ih-oh)*${panY.toFixed(3)}',` +
      `setsar=1,format=yuv420p,settb=AVTB[v${i}]`
    );

    const tempo = plan.atempoChain(speed);

    if (m.hasAudio) {
      // Trim, retime, conform, and nothing else. m.channelFix is measured and
      // reported, deliberately without being acted on: see the note above.
      // Padded and cut to the picture's length, because phone audio often
      // ends a few frames early, and a short leg would make every later clip's
      // sound run ahead of its picture.
      const length = t(plan.clipDuration(c));
      const chain = [...tempo, AUDIO_CONFORM, `apad=whole_dur=${length}`, `atrim=0:${length}`].join(',');
      F.push(
        `[${i}:a]atrim=start=${t(c.in)}:end=${t(c.out)},asetpts=PTS-STARTPTS,` +
        `${chain}[a${i}]`
      );
    } else {
      // A clip with no sound still needs a stream, or concat drops the audio
      // from that point on and the rest of the video plays silent.
      F.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=0:${t(plan.clipDuration(c))}[a${i}]`);
    }
  });

  // Join the clips up, one boundary at a time. A clip's transition describes
  // how it arrives, so clips[0].transition has nothing to attach to.
  let vcur = 'v0';
  let acur = 'a0';

  clips.slice(1).forEach((c, j) => {
    const i = j + 1;
    const kind = plan.TRANSITIONS[c.transition];

    /*
     * A transition is an overlap, and the overlap is the whole of it: the
     * incoming clip simply starts before the outgoing one has finished, which
     * is exactly what starts[i] already says. So the xfade offset is that
     * start, and its duration is the same fade plan.js used to work the start
     * out. Nothing about the timeline is recomputed here.
     *
     * plan.fadeDur returns 0 for a cut, and also for a fade whose clips are
     * too short to hold it, so both fall through to concat below without any
     * special casing here.
     *
     * The test is on the rounded figure rather than the raw one, because an
     * overlap under half a millisecond would print as duration=0.000 and
     * xfade rejects that. It is a cut in every sense that matters.
     */
    const overlap = t(plan.fadeDur(c, clips[j]));

    if (kind && kind.xfade && Number(overlap) > 0) {
      F.push(`[${vcur}][v${i}]xfade=transition=${kind.xfade}:duration=${overlap}:offset=${t(starts[i])}[vx${i}]`);
      F.push(`[${acur}][a${i}]acrossfade=d=${overlap}[ax${i}]`);
    } else {
      F.push(`[${vcur}][${acur}][v${i}][a${i}]concat=n=2:v=1:a=1[vx${i}][ax${i}]`);
    }
    vcur = `vx${i}`;
    acur = `ax${i}`;
  });

  // Nothing is added after the join. The last label the assembly produced is
  // the one that gets mapped out, so the audio leaves at the level it arrived
  // at and Just Sound has an untouched thing to work on.
  const args = [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    ...inputArgs,
    '-filter_complex', F.join(';'),
    '-map', `[${vcur}]`, '-map', `[${acur}]`,
    ...codecArgs(o),
    '-movflags', '+faststart',
    '-t', t(totalDur),
  ];

  return { args, totalDur };
}

// ---------- reading the source files ----------

function runCapture(bin, args, ctl) {
  return new Promise((resolve, reject) => {
    if (ctl && ctl.cancelled) return reject(cancelledError());
    const child = spawn(bin, args, { windowsHide: true });
    if (ctl) ctl.children.add(child);
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', (c) => { out += c; });
    if (child.stderr) child.stderr.on('data', (c) => { err += c; });
    child.on('error', () => resolve({ code: -1, out: '', err: '' }));
    child.on('close', (code) => {
      if (ctl) ctl.children.delete(child);
      if (ctl && ctl.cancelled) return reject(cancelledError());
      resolve({ code, out, err });
    });
  });
}

/*
 * Which channel actually carries the sound.
 *
 * Splits the stereo pair, measures each side, and reports a side only when one
 * is more than 12dB above the other. Below that they are both live and it is
 * just an unbalanced mix, which is nobody's fault. Above it, one channel is
 * silence with bleed on it, which is a camera that put the mic on one side.
 *
 * This is a reading and stays a reading. Just Cut does not repair it, because
 * repairing it would be changing how the audio sounds, which is Just Sound's
 * side of the line. It is measured anyway because the measurement rides along
 * with a probe that has to happen regardless, and validate() turns it into a
 * warning. Telling somebody their audio is broken and leaving it alone beats
 * both fixing it behind their back and never mentioning it.
 *
 * Needs ffmpeg rather than ffprobe, because it is a filter graph measurement.
 */
async function probeChannelBalance(ffmpeg, file, ctl) {
  const { err } = await runCapture(ffmpeg, [
    '-i', file,
    '-af', 'channelsplit=channel_layout=stereo[l][r];[l]astats=metadata=1:reset=0[la];[r]astats=metadata=1:reset=0[ra];[la][ra]amix',
    '-f', 'null', '-',
  ], ctl);

  // ffmpeg tags every stat line with the filter instance that produced it:
  //   [Parsed_astats_1 @ ..] RMS level dB: -21.06
  // instance 1 is the left split, instance 2 the right.
  //
  // A channel carrying nothing whatsoever reads "-inf" rather than a number,
  // and that is the ordinary case here rather than an edge one: a camera that
  // wires the mic to one side usually leaves the other truly empty, not merely
  // quiet. It has to be matched with its sign, which is why the alternative
  // comes first, and it stands in as -120dB so the comparison below is plain
  // arithmetic.
  const byInstance = {};
  for (const line of String(err).split('\n')) {
    const m = line.match(/Parsed_astats_(\d+)[^\]]*\]\s*RMS level dB:\s*(-?inf|-?[0-9.]+)/);
    if (!m) continue;
    if (byInstance[m[1]] === undefined) {
      byInstance[m[1]] = m[2].endsWith('inf') ? -120 : Number(m[2]);
    }
  }

  const left = byInstance['1'];
  const right = byInstance['2'];
  if (left === undefined || right === undefined) return null;
  if (left - right > 12) return 'left';
  if (right - left > 12) return 'right';
  return null;
}

// Above this a reported rate is a timebase, not a frame rate.
const MAX_FPS = 240;

/** Degrees the picture is turned for display, from either place ffprobe puts it. */
function rotationOf(video) {
  for (const side of video.side_data_list || []) {
    const r = Number(side && side.rotation);
    if (Number.isFinite(r) && r !== 0) return Math.round(r);
  }
  const tag = Number(video.tags && video.tags.rotate);
  return Number.isFinite(tag) ? Math.round(tag) : 0;
}

async function probeOne(ffprobe, file, ctl) {
  const { code, out, err } = await runCapture(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], ctl);
  if (code !== 0) {
    // ffprobe's own lines carry a demuxer tag and a memory address
    // ("[mov,mp4,... @ 0x1234] moov atom not found"), which changes every run
    // and means nothing to a person or a script. Keep its last plain line, the
    // reason, without the path it repeats, and say it once.
    const plain = String(err).split('\n').map((l) => l.trim())
      .filter((l) => l && !/^\[[^\]]* @ 0x[0-9a-f]+\]/i.test(l));
    const last = plain.length ? plain[plain.length - 1] : '';
    const reason = last.startsWith(`${file}: `) ? last.slice(file.length + 2) : last;
    throw new Error(`${path.basename(file)} could not be read${reason ? `: ${reason}` : '.'}`);
  }

  const info = JSON.parse(out);
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!video) throw new Error(`There is no picture in ${path.basename(file)}`);

  // ffprobe "reads" a file that only looks like an image (a broken JPEG) and
  // reports a 0x0 picture, which ffmpeg then fails on mid-export with raw
  // output that never says which clip was bad. Said here, it is named.
  if (!(Number(video.width) > 0 && Number(video.height) > 0)) {
    throw new Error(`${path.basename(file)} could not be read: there is no picture in it that can be read.`);
  }
  // A still picture (image2, or a *_pipe image format when the name does not
  // say jpg or png) opens as a video one frame long, and exported as a 0.04
  // second MP4, which is nobody's idea of a cut. GIF is its own format and
  // moves, so it is still a clip.
  const formatName = String((info.format && info.format.format_name) || '');
  if (formatName === 'image2' || /_pipe$/.test(formatName)) {
    throw new Error(`${path.basename(file)} is a picture, not a video. Just Cut cuts video clips.`);
  }

  // avg_frame_rate first: r_frame_rate is the timebase guess, and on variable
  // rate phone footage or webm it reads 90000 or 1000, which would then become
  // the rate of the whole export. On constant rate footage the two agree.
  const rate = (text) => {
    const [num, den] = String(text || '').split('/').map(Number);
    const v = den ? num / den : num;
    return Number.isFinite(v) && v > 0 && v <= MAX_FPS ? v : null;
  };
  const fps = rate(video.avg_frame_rate) || rate(video.r_frame_rate) || 30;

  // ffmpeg turns a rotated phone clip upright as it decodes, so the filter
  // graph sees the picture with its sides swapped. The size has to be the
  // upright one too, or a portrait clip is scaled and cropped as landscape.
  const turned = Math.abs(rotationOf(video)) % 180 === 90;
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;

  return {
    width: turned ? height : width,
    height: turned ? width : height,
    duration: Number(info.format && info.format.duration) || 0,
    fps,
    hasAudio: Boolean(audio),
    sampleRate: audio ? Number(audio.sample_rate) || AUDIO_RATE : null,
    channelFix: null,
  };
}

/*
 * Measure every source file once.
 *
 * `bins` is the ffprobe path, or { ffprobe, ffmpeg } when the caller can also
 * supply ffmpeg. The channel balance reading is a filter graph measurement and
 * ffprobe cannot run one, so given ffprobe alone every clip comes back with
 * channelFix null. The export is identical either way, since nothing acts on
 * it; all that is lost is the warning.
 */
async function probe(bins, files, { ctl } = {}) {
  const ffprobe = typeof bins === 'string' ? bins : bins.ffprobe;
  const ffmpeg = typeof bins === 'string' ? null : bins.ffmpeg;

  const clips = [];
  for (const file of files) {
    const m = await probeOne(ffprobe, file, ctl);
    if (m.hasAudio && ffmpeg) m.channelFix = await probeChannelBalance(ffmpeg, file, ctl);
    clips.push(m);
  }
  return { clips };
}

// ---------- a picture for the tray ----------

/*
 * One frame of a clip as a small JPEG, for the tray's tiles. A fast seek
 * (-ss before -i) lands on the nearest keyframe, which is plenty for a
 * picture, and keeps it one quick call per file. Resolves a Buffer, or null
 * if ffmpeg cannot give one; a missing picture is never an error worth
 * showing anybody, the tile keeps its film icon.
 */
function thumbnail(ffmpeg, file, atSec, width = 240) {
  return new Promise((resolve) => {
    const at = Math.max(0, Number(atSec) || 0);
    const args = ['-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1',
      '-vf', `scale=${Math.round(width)}:-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', '-'];
    let child;
    try { child = spawn(ffmpeg, args, { windowsHide: true }); } catch (e) { return resolve(null); }
    const parts = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', (b) => {
      size += b.length;
      if (size > 2e6) return child.kill();      // a thumbnail is never this big
      parts.push(b);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && size > 0 && size <= 2e6 ? Buffer.concat(parts) : null);
    });
  });
}

// ---------- exporting ----------

function run(bin, args, { onProgress, durationSec, ctl } = {}) {
  return new Promise((resolve, reject) => {
    // A cancel that arrived while the clips were still being measured had no
    // child to kill, so it is honoured here instead of after a whole encode.
    if (ctl && ctl.cancelled) return reject(cancelledError());
    const child = spawn(bin, args, { windowsHide: true });
    if (ctl) ctl.children.add(child);
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      if (!onProgress || !durationSec) return;
      // -progress emits key=value lines, which beats scraping the banner.
      for (const line of String(chunk).split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m) onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / durationSec)));
      }
    });

    // Keep the tail only. A failing ffmpeg says why in the last few lines and a
    // working one can produce megabytes we would otherwise hold in memory.
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (ctl) ctl.children.delete(child);
      if (ctl && ctl.cancelled) return reject(cancelledError());
      if (code !== 0) {
        const why = stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n');
        return reject(new Error(why || `ffmpeg exited with ${code}`));
      }
      resolve();
    });
  });
}

/*
 * Export the project.
 *
 * opts.out is where it goes. Two safety rules apply here and are deliberately
 * not delegated: the never overwrite guarantee is worth more than the cost of
 * checking it twice, and a check that only happens in plan.js stops happening
 * the day someone calls the engine from somewhere else.
 *
 *   1. The destination is asked of plan.isSafeOutput before anything is
 *      spawned. A source file is never a destination.
 *   2. ffmpeg writes to a temp name beside the destination, which is then
 *      renamed into place. Cancelling or crashing halfway leaves a part file,
 *      never a truncated video sitting where a finished one used to be. If the
 *      destination appears in the meantime, the rename is abandoned rather
 *      than forced.
 *
 * The temp file lives in the destination folder rather than the system temp
 * folder on purpose: rename is only atomic within one filesystem, and moving a
 * finished export across volumes is both slow and interruptible, which is the
 * exact thing being avoided.
 */
/*
 * Rename, with a few retries. On Windows an antivirus scanner or the search
 * indexer often holds a file it has just seen being written, and the rename
 * fails with EPERM or EBUSY for a moment. Giving up at once would throw away a
 * finished encode. If it still fails the error says where the export is.
 */
function renameSoon(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const locked = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!locked || attempt >= 9) {
        throw Object.assign(
          new Error(`The export finished but could not be moved into place (${err.code || err.message}). It is at ${from}`),
          { partial: from });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (attempt + 1));
    }
  }
}

async function render(ffmpeg, project, measurements, opts = {}, onProgress = () => {}) {
  const out = opts.out;
  if (!out) throw new Error('Nowhere to save to');

  const problems = plan.validate(project, measurements).filter((p) => p.level === 'error');
  if (problems.length) throw new Error(problems[0].message);

  const sources = (project.clips || []).map((c) => c.src);
  if (plan.isDeviceName(out)) {
    throw new Error(`${path.basename(out)} is a name Windows keeps for a device, so nothing would be saved. Choose another name.`);
  }
  if (!plan.isSafeOutput(out, sources)) {
    throw new Error('That would write over one of your own clips');
  }
  if (fs.existsSync(out)) throw new Error('There is already a file there');

  const ctl = opts.ctl || control();
  const { args, totalDur } = buildRender(project, measurements, opts);

  const dir = path.dirname(out);
  const tmp = path.join(dir, `.justcut-${process.pid}-${Date.now()}.part.mp4`);

  try {
    await run(ffmpeg, [...args, tmp], {
      durationSec: totalDur,
      ctl,
      onProgress: (v) => onProgress({ stage: 'Exporting', progress: v }),
    });
  } catch (err) {
    // A failed or cancelled encode leaves a part file worth nothing, and it is
    // the only thing this function ever deletes.
    try { fs.unlinkSync(tmp); } catch { /* already gone, or never written */ }
    throw err;
  }

  // A cancel that landed after the encode had finished still stops here:
  // nothing is moved into place that the person asked not to have.
  if (ctl.cancelled) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw cancelledError();
  }

  /*
   * Last look before the move.
   *
   * If something else claimed the name while we were encoding, stop. The
   * finished export is right there in the temp file and can be moved by hand;
   * whatever appeared at the destination may be the only copy of itself. So
   * the part file is deliberately left in place here rather than cleaned up,
   * and the message says where it is.
   */
  if (fs.existsSync(out)) {
    throw Object.assign(
      new Error(`Something else wrote to ${path.basename(out)} while this was exporting, so it was left alone. Your export is at ${tmp}`),
      { partial: tmp }
    );
  }
  renameSoon(tmp, out);

  onProgress({ stage: 'Done', progress: 1 });
  return { path: out, totalDur };
}

module.exports = {
  buildRender,
  probe,
  probeChannelBalance,
  render,
  thumbnail,
  control,
  targetFps,
};
