# Just Cut

Cuts a video down and puts the pieces in order. Trim the dead air off the ends,
split where you want a jump, set pieces aside in the tray and drag them back
in the order you meant, speed a section up, join clips with a fade, reframe the whole thing for a phone, and
export. Everything happens on your machine.

Built because the gap between "trim the start of this" and "install a video
editor" is enormous, and almost every free answer in the middle is either a
website you upload your footage to or a wall of ffmpeg flags you have to get
right on the first go.

**Version 1.0.0**, the first release: a desktop app for Mac, Windows and
Linux, and a command line on npm.

## What it does

- **Trim** each clip to the part worth keeping, from either end.
- **Split** a clip at the playhead, which is how a jump cut gets made.
- **Reorder** the pieces. The timeline is a list, and moving one moves it.
- **Set pieces aside** in the tray, a bin of picture tiles beside the timeline.
  Several files added at once wait there; drag a piece out to park it, and
  drag it back in wherever it belongs. Nothing in the tray is exported.
- **Undo** anything, and redo it, with the arrows by the timeline or the usual
  keys.
- **Speed** from 0.1x to 10x on the command line (0.25x to 4x in the window),
  with audio pitch handled rather than ignored.
  Past 0.25x or 4x it still works, it just starts to sound like it.
- **Join** with a cut, a fade or a slide. Each join is a chip on the seam; pick
  one and the seam plays so you see it. Half a second, which is long enough to
  read as deliberate and short enough to fit in a short clip.
- **Reframe** to vertical (9:16), square (1:1), widescreen (16:9), or leave the
  source frame alone. It crops and pans rather than letterboxing, so a phone
  video stays full bleed.
- **Export** once, as one ffmpeg run.

## What it deliberately does not do

It cuts audio. It does not treat it.

Trimming, retiming, joining and crossfading the sound is unavoidable, because
there is no cutting a video without cutting the audio that runs under it, and a
clip with no audio track gets silence so that everything after it does not play
mute. All of that is structure, and structure is this tool's job.

Changing how the result *sounds* is not. There is no loudness pass here, and no
repair of a clip recorded onto one channel. The levels come out as they were
recorded. That work lives in **Just Sound**, which takes a video and gives back
a video, so the two chain in either direction:

```sh
justsound "$(justcut clip.mp4 --trim 0:30 --quiet)"
```

Both of those features were in here once, added because they needed no extra
binary and a trimmed video with broken sound is annoying. That left two
implementations of one thing which had to agree with each other forever, which
is the failure this whole family of tools is built to avoid. One copy went.

Just Cut still *measures* channel balance, because the reading rides along with
a probe that has to happen anyway. A clip recorded onto one side only gets said
out loud on stderr (unless `--quiet`) and then left exactly as it was. Telling somebody their audio
is broken beats both fixing it behind their back and never mentioning it.

## The rules it follows

- **Your originals are only ever read.** Output goes to `name-edit.mp4` beside
  the first clip, and never to a path that already exists. An export is written
  to a temporary name beside itself and renamed into place, so an interrupted
  run cannot leave half a file where a good one was.
- **Nothing is uploaded.** There is no network code in the app at all: no
  telemetry, no crash reporter, no update checker, no account.
- **What the preview says is what the export does.** Both read the same
  timeline module. There is no second implementation to drift.
- GPL v3 or later, like the ffmpeg builds it carries.

## Running it from a checkout

```sh
nvm use                  # Node 22, per .nvmrc. Not optional, see below.
npm ci
npx install-electron     # Electron 43 has no postinstall, see below.
npm run fetch-ffmpeg     # puts ffmpeg and ffprobe in vendor/
npm start
```

Two steps there look redundant and are not, and both were found the hard way:

**`nvm use` matters.** Electron's installer does `require('@electron/get')`,
which is now an ES module, so it needs `require(esm)`. That arrived in Node
22.12. On Node 18 the install fails with `ERR_REQUIRE_ESM` and you get a
checkout that tests fine and cannot open a window.

**`npx install-electron` matters.** Electron 43 dropped its postinstall script:
its published `package.json` has no `scripts` field at all, only a bin named
`install-electron`. So `npm ci` completes in seconds, reports success, and
downloads none of the 295MB binary. Nothing warns you until `npm start` fails.

## The command line

The CLI is a wrapper around the same two modules the window uses, not a second
implementation, so it produces the same output for the same edit.

```sh
justcut clip.mp4 --trim 3:48 --format vertical
```

```
Just Cut 1.0.0
Cut a video down and put the pieces in order.

  justcut <clip> [options]
  justcut <clip> [clip options] <clip> [clip options] ... [options]
  justcut --job project.json -o cut.mp4
  cat project.json | justcut --job - --dry-run

Clips
  Clips are joined in the order you name them. --trim, --speed and
  --transition describe the clip they follow, so each clip is set up right
  after it is named.

  --trim <start:end>    the part to keep. Each side is seconds, mm:ss or
                        hh:mm:ss, and both sides are written the same way so
                        the colon in the middle is never ambiguous. Leave a
                        side off for "from the start" or "to the end": ":30"
                        is the first 30 seconds, "1:00:" is from one minute
                        onwards.
  --speed <n>           playback speed from 0.1 to 10. 1 leaves it alone.
  --transition <name>   how this clip joins the one before it. Given before
                        any clip it sets the join for the whole edit.
                        One of: cut, fade, slide

Whole edit
  --format <name>       what shape to finish in.
                        One of: source, vertical, square, wide
  --pan <x,y>           where to sit the picture when reframing crops it, 0 to
                        1 on each axis. Default 0.5,0.5, the middle.
  --job <path|->        read the whole edit from a project file instead of
                        from flags, "-" for standard input, which is the only
                        time standard input is read. Flags given as well win,
                        so a saved project can be re-run to another shape.

Sound
  There are no sound options, and that is on purpose. This cuts audio, it
  does not treat it. Clips are trimmed, retimed, joined and crossfaded,
  because there is no cutting a video without cutting the sound under it, and
  a clip with no audio track gets silence so the rest does not play mute.
  Nothing here changes how the result sounds: the levels come out the way
  they were recorded.

  Evening out loudness, and rescuing a clip recorded onto one channel only,
  belong to Just Sound. It takes a video and gives back a video, same as this
  one, so the two chain:

    justsound "$(justcut clip.mp4 --trim 0:30 --quiet)"

  A clip that is only on one channel is still noticed, and said on stderr
  unless --quiet, and then left exactly as it was.

Output
  -o, --output <path>   where to write, a name ending in .mp4. Defaults to
                        name-edit.mp4 beside the first clip, then name-edit
                        2.mp4 and so on. Never a clip, and never a file that
                        is already there: it refuses instead of overwriting.
                        Not "-": an MP4 cannot be read before it is finished.
  --lossless            write a lossless intermediate instead of a file to
                        send: the same MP4, with H.264 at -qp 0 and ALAC
                        sound. Often ten times the size, and not every player
                        opens it. For a step in the middle of a chain of
                        tools.
  --json                results as JSON lines on stdout instead of the bare
                        path: a result line, or an error line, then a done
                        line.
  --progress            with --json, progress as JSON lines on stderr.
  --dry-run             print the timeline and the ffmpeg command it would
                        run, and then run nothing at all. The clips are still
                        read, to measure them. With --json the plan is the
                        result line.
  --quiet               nothing on stderr but errors: no progress, no notes
                        about the clips and no closing line.
  --describe            print these options as JSON, with their types,
                        defaults and ranges, and then do nothing else. For a
                        script, or an assistant, that would otherwise be
                        guessing at flags.
  -h, --help            this.
  -V, --version         version.

The --job file is the same object the app uses:
  { "clips": [ { "src": "a.mp4", "in": 0, "out": 12, "speed": 1,
                 "transition": "fade" } ],
    "format": "vertical", "pan": { "x": 0.5, "y": 0.5 } }

Exit status: 0 done, 1 failed, 2 usage (nothing was started), 129, 130 or 143
stopped by a signal, with the part file deleted.

Your clips are only ever read. Nothing is written over, and nothing is
uploaded: this makes no network connection of any kind.
```

Progress goes to stderr so stdout stays clean enough to pipe. Give more than
one file and they are joined in the order you gave them.

It follows the command-line contract every Just tool keeps, so a script, an
assistant or Just Tool Belt can drive it without guessing:

- `--describe` prints what it accepts as JSON (`ponderdev.cli-describe/1`),
  built from the same option table as `--help`. `--help`, `--version` and
  `--describe` answer before anything else is looked at.
- `--json` puts JSON lines on stdout instead of the bare path: a `result` line
  (`input`, `output`, `bytes`, `width`, `height`, `duration` and the rest) or
  an `error` line with a `code` such as `usage` or `not-a-video`, then a `done`
  line, always. `--progress` adds progress lines on stderr.
- `--job <file>` reads the whole edit from a project file, or from stdin with
  `-`. Stdin is read then and never otherwise.
- `--lossless` writes H.264 at `-qp 0` with ALAC sound in the same MP4, for a
  step in the middle of a chain. It is often ten times the size and not every
  player opens it.
- Exit status: 0 done, 1 failed, 2 usage (nothing was started), 129, 130 or 143
  stopped by a signal, with the part file deleted.
- The output is `name-edit.mp4` beside the first clip, then `name-edit 2.mp4`.
  It never writes over a file, so there is no `--overwrite`, and it cannot
  write to stdout (`-o -`), because an MP4 has to be finished before anything
  can read it.

`justcut --help` on the copy you actually have is the list that counts.

Unlike the desktop app, the CLI does not have to carry its own encoder:
`src/binaries.cjs` uses a bundled binary if one is beside it and otherwise
whatever `ffmpeg` and `ffprobe` are on your PATH, which on Linux is one package
away (`pacman -S ffmpeg`, `apt install ffmpeg`). The app is the opposite and
bundles its own, because someone downloading a finished app should not then be
told to install a video encoder.

Needs Node 22 or newer, and `ffmpeg` and `ffprobe` on the PATH (no minimum
version has been tested).

### For Claude and other assistants

The package carries an agent skill, `agents/skills/justcut/SKILL.md`, that
tells an AI assistant when to reach for Just Cut and how to drive it. Installing
the command line with `npm install -g` links it in for the assistants set up on
the machine: into Claude Code's skills folder (`~/.claude/skills/justcut`, or
under `$CLAUDE_CONFIG_DIR`), and into `~/.agents/skills/justcut`, the shared
folder that Codex, Gemini CLI, Copilot, Cursor, OpenCode, Amp and Goose read.
Updating the package updates the skill with it. It never replaces a folder or
a link that is already there, and `npm install -g --ignore-scripts` skips it.
After uninstalling, remove the leftover links with
`rm ~/.claude/skills/justcut ~/.agents/skills/justcut`.

## How it is put together

Four layers, and the split is the reason any of it is testable:

- **`src/plan.js` decides.** Where a clip sits on the timeline, how long a
  transition can be, what size the output frame is, where the crop lands, and
  which file it is safe to write to. Pure functions over plain objects: no
  ffmpeg, no filesystem, no Electron, no DOM. It loads as a CommonJS module in
  node and as a plain `<script>` in the renderer, so the editor and the export
  path share one copy of the arithmetic instead of agreeing by hand.
- **`src/engine.cjs` does the work.** Turns a project into one ffmpeg run.
  `buildRender()` is pure and returns the exact argument list, which is what
  the golden tests pin down; `probe()` and `render()` are the parts that touch
  the disk. It knows nothing about Electron, so it runs from a plain node
  script, which is the only reason a CLI is cheap.
- **`src/main.cjs` wires.** Windows, menus, dialogs, IPC, and handing the
  engine its binary paths.
- **`src/renderer/` shows.** The timeline, the preview and the controls.

## ffmpeg

`vendor/` is not in git: the binaries are large, they are not ours to
redistribute through our own history, and they move on someone else's schedule.
`npm run fetch-ffmpeg` pulls them, `--all` gets every build a release needs,
and `--verify` re-checks what is already there without downloading anything.

Any GPL build with libx264 works. If a host moves, drop the binaries in by hand
as `ffmpeg-darwin-arm64`, `ffprobe-linux-x64` and so on, or with `.exe` on
Windows. The names carry the platform as well as the arch because Linux and
macOS both call themselves x64.

**Apple Silicon** builds come from osxexperts.net, since evermeet publishes
x86_64 only. Those are checked against a published SHA-256 before installing,
and the script refuses rather than installs on a mismatch. The published hash
is of the binary inside the zip rather than of the zip, because a zip is not
byte stable and hashing it would go stale without the binary changing.

**Every build is asked how it was made before it is allowed to stay.** ffmpeg
embeds its configure line, so the script reads it, by running the binary where
it can and out of the bytes where it cannot, and refuses anything built
`--enable-nonfree`, anything missing `--enable-gpl`, and any ffmpeg without
libx264. A nonfree build reports itself as "nonfree and unredistributable" and
may not be shipped by anybody. The private app this was carved out of shipped
one for its entire life because nothing ever looked, which is exactly why this
looks every time.

## Licences

GPL-3.0-or-later, like the ffmpeg builds it carries.
`THIRD-PARTY-NOTICES.md` names every bundled component, its licence, where its
source is, and how the terms are met point by point. `licenses/` holds the full
texts, fetched from the licensors rather than retyped. Both are readable from
inside the app under **Licences and credits** in the footer.

`npm run licences` regenerates that screen from those two, and the dist scripts
run it first, so a credits screen that has drifted from what is bundled cannot
ship.

## Tests

```sh
npm test                 # everything that needs no window, ffmpeg tests included
npm run test:window      # the window boots and renders, offscreen
npm run test:all         # both
```

`plan.test.cjs` covers the decisions, `render.test.cjs` pins the exact ffmpeg
arguments a project produces, and `safety.test.cjs` covers the one thing that
cannot be undone: never writing over a source file. `cli.test.cjs` runs the
command line as a subprocess, real exports included, and `contract.test.cjs`
holds it to the command-line contract: the JSON lines, the exit codes, the
output names, and a signal mid-export leaving nothing behind. The tests that
need footage make it with ffmpeg and skip themselves when there is none.

`test:window` starts Electron through `scripts/electron.cjs`, which takes
`ELECTRON_RUN_AS_NODE` out of its environment, so it runs the same on Windows.
