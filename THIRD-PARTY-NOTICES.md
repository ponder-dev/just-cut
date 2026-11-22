# Third party notices

Just Cut is built on other people's work. This file records what it carries,
under what terms, and where to get the original source. The full licence texts
are in the `licenses/` folder and are also readable inside the app under
**Licences and credits** in the footer.

Just Cut itself is GPL-3.0-or-later. See `LICENSE`.

Two things are worth saying up front, because they keep this list short. Just
Cut has **no npm runtime dependencies at all**: nothing under `node_modules`
ships. And it sends nothing over a network: the only links in it (the footer's
credit and the "How it works" button in the start screen's "What's this?" note) open ponderdev.com in your own
browser when you press them, so nothing here is a service, an API or a model,
only code that runs on the machine it was installed on.

---

## FFmpeg and ffprobe

FFmpeg does all of the actual work. Every trim, join, speed change, reframe and
export is an ffmpeg invocation. `ffprobe`, from the same project, reads the
duration, resolution, frame rate and stream layout that `src/plan.js` does its
arithmetic on.

- Project: <https://ffmpeg.org>, source at <https://github.com/FFmpeg/FFmpeg>
- FFmpeg's own core is **LGPL v2.1 or later**, with some files under MIT, X11
  or BSD terms. Full text: `licenses/ffmpeg-license.txt`, with the LGPL itself
  in `licenses/lgpl-2.1.txt`.
- Every build bundled here is configured with `--enable-gpl`, which pulls in
  the GPL-licensed parts, including x264, and moves the whole binary to the
  GPL. Builds that also carry `--enable-version3` are **GPL v3 or later**;
  builds without it are **GPL v2 or later**. Both texts ship:
  `licenses/gpl-3.0.txt` and `licenses/gpl-2.0.txt`.

**The bundled binaries are not built here and are not modified.** They are
published builds, taken exactly as the publisher shipped them. The publishers
differ per platform, and so do their configure lines, so the effective licence
is stated per build rather than once for all of them:

| Platform and arch | Publisher | Licence, from the configure line |
| --- | --- | --- |
| macOS x86_64 | [evermeet.cx/ffmpeg](https://evermeet.cx/ffmpeg/) | `--enable-gpl --enable-version3`, so **GPL v3 or later** |
| macOS arm64 | [osxexperts.net](https://www.osxexperts.net) | `--enable-gpl`, no `--enable-version3`, so **GPL v2 or later** |
| Windows x86_64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (the `win64-gpl` build) | `--enable-gpl --enable-version3`, so **GPL v3 or later** |
| Linux x86_64 | [johnvansickle.com/ffmpeg](https://johnvansickle.com/ffmpeg/) (static) | `--enable-gpl --enable-version3`, so **GPL v3 or later** |

Those readings were taken from the builds those four sources served in August
2026. Publishers change their configure lines, so the copy on your machine is
the authoritative answer for your copy:

```sh
# macOS, from inside the installed app
"/Applications/Just Cut.app/Contents/Resources/ffmpeg/ffmpeg-darwin-arm64" -version

# from a checkout
./vendor/ffmpeg/ffmpeg-darwin-arm64 -version
```

`scripts/fetch-ffmpeg.mjs` is what downloads them, and it is the complete
record of where they came from: the URLs above are in it, the mac arm64 build
is pinned to a published SHA-256, and the script prints the licence it read out
of each binary as it installs it.

**On the command line, ffmpeg may not be bundled at all.** `src/binaries.cjs`
takes a bundled binary if one is sitting beside it and otherwise uses whatever
`ffmpeg` and `ffprobe` are on your PATH. When it uses your system's build, the
terms that apply are that build's, not anything shipped here. The desktop app
always carries its own copy, because someone downloading a finished app should
not then be told to go and install a video encoder.

### The nonfree check

`scripts/fetch-ffmpeg.mjs` refuses any build configured `--enable-nonfree`, or
any build carrying the string `nonfree and unredistributable` that such a build
prints about itself. A nonfree build combines FFmpeg with code whose terms
cannot be combined with the GPL, and the result may not be redistributed by
anybody, whatever licence the application around it uses.

This check exists because it caught a real one. The private app Just Cut was
carved out of shipped an Apple Silicon ffmpeg built `--enable-nonfree` for its
entire life. Nothing ever asked the binary what it was, so nobody ever knew.
The check now runs on every fetch and on every binary already present, so a
build that cannot be shipped cannot quietly become the one that ships. The same
run also insists on `--enable-gpl`, and on `libx264` in ffmpeg, since the app
cannot export without it.

## x264

The H.264 encoder. Every video Just Cut writes comes out of it.

- Project: <https://www.videolan.org/developers/x264.html>
- **Licence: GNU GPL v2 or later.** Full text: `licenses/gpl-2.0.txt`
- Compiled into the FFmpeg builds above, unmodified. It is the reason those
  builds are GPL rather than LGPL.

## x265

The H.265 encoder, compiled into the same builds. Just Cut does not currently
encode H.265, but the binaries carry it, so it is listed.

- Project: <https://www.videolan.org/developers/x265.html>
- **Licence: GNU GPL v2 or later.** Full text: `licenses/gpl-2.0.txt`

## Everything else inside FFmpeg

These builds also carry libaom, libvpx, libopus, libvorbis, libmp3lame,
libwebp, libass, libfreetype, dav1d, libtheora, libzimg and several dozen
more, each under its own terms, mostly BSD, LGPL or MIT. They are not listed
individually here because the list belongs to the build rather than to this
app, and it changes when the build does. Which of them ends up in your copy is
not something this project decides, and `ffmpeg -version` prints the exact
configuration of the binary you have.

## Electron, Chromium and Node.js

The application shell: Chromium draws the window, Node handles the files.

- Project: <https://www.electronjs.org>, source at
  <https://github.com/electron/electron>
- **Licence: MIT.** Full text: `licenses/electron-mit.txt`
- Electron is a devDependency here, because no source file in this repo needs
  it at runtime, but electron-builder packs the Electron runtime into the
  desktop app, so it is genuinely bundled and belongs in this list.
- Electron carries Chromium and Node.js, which are themselves hundreds of
  components under their own terms. Their combined licence text ships inside
  the packaged app as `LICENSES.chromium.html`, put there by Electron rather
  than by us, and it is far too large to reproduce here.
- The command line does not use Electron at all.

## What is not here

No fonts are bundled: the interface uses the system UI font. No models, no
sounds, no icon sets, no analytics, no crash reporter, no update checker. If
that changes, this file changes with it in the same commit.

---

## Meeting the GPL terms

FFmpeg as shipped here is GPL, v3 or later on three platforms and v2 or later
on Apple Silicon. Distributing it inside an application carries obligations,
and Just Cut meets them like this:

0. **Compatibility.** Just Cut is GPL-3.0-or-later. GPL v2-or-later code can
   be combined with it, since "or later" permits v3, so there is no
   combination problem to solve in either direction.
1. **Notice.** This file, and the credits screen inside the app, name every
   bundled component, its licence and whether it was modified. Nothing was
   modified.
2. **Licence texts.** Shipped in full, in `licenses/`, in the packaged app, and
   readable from the footer without leaving the app. GPL v3, GPL v2 and LGPL
   v2.1 are all present, because all three are needed to cover what is here.
3. **Source.** Linked above, for every component. The FFmpeg binaries are
   published builds used as-is, so the upstream source at
   <https://github.com/FFmpeg/FFmpeg> is the complete corresponding source for
   them. Just Cut's own source is the repository this file is in:
   <https://github.com/ponder-dev/just-cut>.
4. **Replacing them.** The binaries live in `vendor/ffmpeg` in a checkout, and
   beside the app in `Resources/ffmpeg` once packaged. They are found by name
   at runtime and spawned as separate processes: nothing is statically linked
   into the app and nothing is patched. Drop your own GPL build in under the
   same filename and the app uses it instead.
5. **Provenance.** `scripts/fetch-ffmpeg.mjs` records exactly where each binary
   came from, pins the one publisher that offers a hash, and checks every
   binary's own report of how it was built before allowing it to stay.

If you would rather have the source on a disk than a link, ask and it will be
sent.

## A note on H.264 patents

H.264 is covered by patents in some countries. Just Cut encodes H.264 with
x264, an independent open source encoder, and the licences above cover the
copyright in that software and nothing else. Patent licensing is a separate
matter from the software licence. If you are redistributing Just Cut
commercially or at scale, take your own advice on what that means where you
operate.
