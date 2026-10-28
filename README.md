# Portfolio

## Content delivery

Netlify runs `node --test tests/*.test.mjs && node scripts/build.mjs` and publishes
`dist/` (configured in `netlify.toml`). Node 22+, no npm dependencies or secrets
are needed. The build reads `settings/profile.json`, all `projects/*.json`, and
all `posts/*.json` and embeds a safely escaped JSON snapshot in the published
HTML. The browser makes **zero content requests** to GitHub or any JSON endpoint.
The original category filters, numeric ordering (including the existing fallback
for zero/missing order), card templates and media URLs are retained.

Netlify CMS still uses Git Gateway and commits to `main`. With the existing
Netlify continuous deployment enabled for `main`, publishing a CMS change
triggers a new build. Added, edited, and deleted JSON files are discovered on
every build; there is no manually maintained manifest. Content becomes visible
when that deployment succeeds. The HTML and its embedded data are from the same
commit. Invalid/missing source JSON fails the build, so Netlify does not replace
the previous successful deployment with incomplete content.

`admin/`, uploads, favicons, robots.txt, and other public assets are copied to
`dist/` without modification. CMS authentication still requires Netlify/GitHub;
visitors' portfolio rendering does not. External media and fonts still depend
on their respective providers. If the Markdown CDN is unavailable, escaped plain
text is rendered instead. Invalid embedded data displays an explicit error;
valid empty collections display an empty state.

## Local verification

```sh
node --test tests/*.test.mjs
node scripts/build.mjs
python3 -m http.server 8080 --directory dist
```

Serve `dist/`, not the source HTML: the source contains an unfilled JSON marker.
Tests exercise the real client script in a minimal DOM harness, including all
categories, ordering, media URLs, failed network calls, HTTP 403/429/500,
corrupt/empty content, and CMS-style create/edit/delete changes. They are not a
full browser or an authenticated CMS end-to-end test.

For a hosting smoke test, confirm the Netlify production deploy succeeds, open
its URL, check all three categories and both publication cards, then block
`api.github.com` in browser DevTools and reload. No visitor content requests
should appear. Publish a real CMS edit when needed and confirm the resulting
Netlify deployment includes it. Do not disable continuous deployment or override
the build command/publish directory in a more specific Netlify deploy context.
