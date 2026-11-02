# Portfolio

## Build and CMS

Node 22+. Netlify installs dependencies from `package-lock.json`, then runs
`npm test && npm run build` and publishes `dist/` (`netlify.toml`). Locally:

```sh
npm ci
npm test
npm run build
python3 -m http.server 8080 --directory dist
```

The build reads `settings/profile.json`, `settings/sounds.json`, `projects/*.json`
and `posts/*.json` and embeds escaped JSON in the HTML. Visitors make no GitHub or
JSON content requests. CMS still uses Git Gateway and commits to `main`; its create,
edit and delete operations trigger the existing Netlify deployment. Invalid source
content fails the build before replacing the previous output. Media/admin assets
are preserved. External media, fonts and CMS authentication retain their providers.
If the Markdown CDN fails, escaped plain text still renders.

## Listening and content

The biography, portrait, contacts and tools share one hero card. Selected music is
a title/duration list; titles come from audio metadata (the existing filename for
«Столпы Сибири»). Optional `audio_title` and `audio_duration` fields are CMS-editable.
All original projects, media and blog posts remain, with Voiceover/Foley links to
the owner's existing Drive folders. Sharing permissions were not changed.

A single hidden audio element powers the bottom dock, shown only on playback.
The dock has circular play/pause, artist/title, real waveform seeking, time,
previous/next, volume and close, without artwork or a lower social/action row.
Native range controls preserve keyboard seeking and accessible time feedback.
Closing pauses/hides and restores initiating-button focus. Catalog play buttons
use that same player. Native media cannot overlap; external iframe playback remains
controlled by the provider. The original rising gold spheres are retained with a
static reduced-motion alternative.

## Automatic waveform generation

The production build automatically generates real 220-bin normalized peaks for new
or replaced local project audio with the pinned `ffmpeg-static` npm decoder. It
does not rely on a system-installed FFmpeg or require manual CMS follow-up.
`settings/waveforms.json` is an optional precomputed cache: matching source URL and
SHA-256 reuse its data. A new hash triggers decoding during the same normal build.
Generated peaks are embedded in the page; no visitor waveform fetch is required.

The decoder is restricted to validated local uploads (no path traversal/symlink
escape), local file/pipe protocols, one thread, a 30-second timeout and 64MiB decoded
output. Unsupported/malformed/oversized audio produces a build warning and an
honest standard seek-bar fallback, not a fabricated waveform. Missing dependencies
or installation failures fail the build; the deployed last successful site remains.
The optional Python generator can refresh the committed cache, but is not required
for automatic CMS audio changes. New results are derived build data, not CMS edits.

## Intro reveal geometry

The card retains its own layout in ordinary document flow. A real top spacer
centers the card at the viewport midpoint: `max(0, (viewportHeight-cardHeight)/2
- normalCardTop)`. This accounts for navigation instead of centering only the
remaining area. Tall cards clamp top space to zero to remain readable. A real
bottom spacer is measured as `max(160px, viewportHeight - centeredCardBottom)`. Main content
is hidden only by JavaScript; without JS it stays accessible. A first Listen click,
arrow, downward wheel/key gesture or upward swipe reveals the main content and
animates both spacers' **actual heights** together: the top to **0px** and the
bottom to **32px** over
**1100ms**, with `cubic-bezier(.16,1,.3,1)` deceleration. The first heading ends 32px
below the card. The content only fades; no translated container or negative margin
pretends to change the gap. Hero padding/alignment never changes during reveal; the top spacer naturally
moves the whole card upward. Both animations share the same document timeline
start and easing, avoiding independent starts or flex-alignment jumps.

While that one animation runs, eligible scroll gestures are prevented to avoid
native scrolling competing with collapsing layout. The handlers release on finish,
cancel, navigation or page hide; no body overflow/scrollbar lock is used. Repeated
triggers cannot restart the animation. Arrow/first Listen do not issue scroll calls.
Inputs, media controls and modifier gestures are excluded. Reduced-motion or missing
animation support sets the final gap immediately. Section navigation/deep links and
restored history use the compact state rather than replaying the intro.

## Verification and review archive

Automated tests cover real decoder output for new/replaced CMS audio, cache hashes,
waveform seek/fallback, dock interactions, category filters, CMS edits/errors, forms,
and measured spacer keyframes/final32px/bounded gesture prevention. A DOM harness
is not visual validation: browser access restrictions prevented real rendering and
motion inspection. Live form delivery and authenticated CMS publishing are not
claimed as tested.

The lightweight ZIP is a review preview plus changed files to overlay on the
original repository, not a complete deployment archive. Its preview uses original
live-site media and needs Internet. Production uses the normal build output.
