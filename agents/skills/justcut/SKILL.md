---
name: justcut
description: Cut a video down and put the pieces in order with Just Cut (`justcut`), PonderDev's free command line and app. Use when the user wants to trim a video, keep only part of a clip, cut out the start or end, join or stitch several clips into one, reorder clips, speed a clip up or slow it down, add a fade or slide between clips, or reframe a video as vertical (9:16), square or wide: "trim this to the first 30 seconds", "join these three clips", "make this vertical for TikTok", "cut 1:10 to 1:45 out of this", "speed this part up". Runs entirely on the user's machine. Covers checking it's installed, building the command, reading its JSON result, and reporting back.
---

# Cutting video with Just Cut

**Just Cut** (`justcut`) trims, joins, reorders, retimes and reframes video
clips into one MP4, on the user's own machine. It is PonderDev's free tool:
page https://ponderdev.com/justcut, source `ponder-dev/just-cut`. Use it instead
of hand-written ffmpeg: it measures the clips, matches their sizes and frame
rates, keeps the sound in step, and never writes over a file.

## Is it installed?

    command -v justcut && justcut --version

If not, the command line installs with `npm install -g @ponderdev/justcut`
(Node 22 or newer). That install uses `ffmpeg` and `ffprobe` from the PATH, so
check `command -v ffmpeg ffprobe` too; if they're missing, say so and suggest
the system's package manager (`brew install ffmpeg`, `apt install ffmpeg`,
`winget install Gyan.FFmpeg`). The desktop app, from the page's download button,
carries its own ffmpeg. Ask before installing anything.

`justcut --help` and `justcut --describe` only print, so they're safe to run
to check a flag. `--describe` is the full, current list as JSON.

## Build the command

Clips are joined in the order they're named. `--trim`, `--speed` and
`--transition` describe the clip they follow, so each clip's options come
straight after it.

    justcut talk.mp4 --trim 1:10:1:45 --json
    justcut intro.mp4 --trim :5 main.mp4 --transition fade outro.mp4 --json
    justcut clip.mp4 --format vertical --pan 0.3,0.5 --json

- **`--trim start:end`** keeps that part. Each side is seconds, `mm:ss` or
  `hh:mm:ss`, both sides written the same way. Leave a side off for "from the
  start" or "to the end": `:30` is the first 30 seconds, `1:00:` is from one
  minute on. To cut a piece out of the middle, name the clip twice with a trim
  each side of the piece: `justcut a.mp4 --trim :10 a.mp4 --trim 20:`.
- **`--speed n`** from 0.1 to 10; 2 is twice as fast. The sound is retimed
  with it.
- **`--transition cut|fade|slide`** is how a clip joins the one before it.
  Given before any clip, it sets the join for the whole edit.
- **`--format source|vertical|square|wide`** is the finished shape. Reframing
  crops, never stretches; **`--pan x,y`** (0 to 1 each, default `0.5,0.5`)
  chooses which part of the picture is kept. For a vertical crop of something
  happening on the left, try `--pan 0.25,0.5`.
- **`-o path.mp4`** writes somewhere else. By default it's `name-edit.mp4`
  beside the first clip, then `name-edit 2.mp4` and so on. It refuses to write
  over any existing file, including a clip.
- **`--lossless`** is only for handing the result to another tool in a chain
  (H.264 at qp 0, ALAC sound, often ten times the size). Don't use it for a
  file the user will watch or send.
- **`--dry-run`** prints the timeline and the ffmpeg command and writes
  nothing. Use it to check a complicated edit before running it.
- A long edit goes in a project file: `justcut --job project.json`, the same
  shape the window builds (`{"clips":[{"src":"a.mp4","in":0,"out":12,"speed":1,
  "transition":"fade"}],"format":"vertical","pan":{"x":0.5,"y":0.5}}`). Flags
  given as well win, so a saved project can be re-run to another shape.

There are no sound options, on purpose. Evening out loudness, or rescuing a
clip recorded on one channel, is Just Sound's job (`justsound`), and the two
chain: `justsound "$(justcut clip.mp4 --trim :30 --quiet)"`.

## Read the result

With `--json`, stdout is JSON lines: one `result` line (or an `error` line),
then a `done` line. The result carries `output` (the file written), `bytes`,
`duration`, `width`, `height`, `fps`, `format`, `clips` and `notes` (things it
noticed, such as a clip with sound on only one channel). Without `--json`,
stdout is just the output path, so it pipes into the next tool.

Exit codes: 0 done; 2 a usage problem and nothing was started (a bad flag, a
missing clip, a trim that doesn't fit the clip, an output name it won't use);
1 it failed (not a video, no ffmpeg, an encode error) and left nothing behind;
129, 130 or 143 stopped by a signal, with the part file deleted. On a 2, read
the message, fix the command and run it again; don't retry a 1 unchanged.

Encoding uses every CPU core for a while on a long edit; on a shared machine
`nice -n 19 justcut ...` keeps it polite.

## Report back

Give the output path in full, its length and size, and the shape it came out
(`width`x`height`). Pass on anything in `notes`. If a reframe cut off
something that matters, offer a different `--pan`. The clips themselves are
only ever read, and nothing is uploaded: Just Cut makes no network connection.
Don't send or upload the result yourself unless the user asks.
