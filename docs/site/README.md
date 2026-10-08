# The CytoWeave website

The website at <https://robert-mcdermott.github.io/cytoweave/> is built from
this folder. GitHub Pages serves it from the `gh-pages` branch of this
repository. That branch holds only the built site, with no history from
`main`.

```text
docs/site/
  build.mjs          the generator: layout, menus, screenshots, link check
  assets/            site.css, site.js and the link-preview image (og-image.jpg)
  pages/             index, install, science and 404
  pages/docs/        the user guide, one file per page
docs/images/         the screenshots, <scene>-light.webp and <scene>-dark.webp
docs/capture/        the script that takes the screenshots
```

## Updating the site

1. Edit the pages in `pages/` (see [Writing pages](#writing-pages)).
2. While you work, build into any folder to check the pages:

   ```sh
   node docs/site/build.mjs /tmp/cytoweave-site-check
   ```

   The build checks every local link, anchor and screenshot. It exits with
   an error and lists the problems if any are broken.
3. When a release is out, build into your checkout of the `gh-pages` branch,
   `../cytoweave-site` beside this repository. Committing that checkout
   publishes the site, so the build writes into it only with `--publish`:

   ```sh
   node docs/site/build.mjs --publish
   ```

4. Preview the site:

   ```sh
   python3 -m http.server 8800 --directory ../cytoweave-site
   ```

   Then open <http://localhost:8800>.
5. Publish it:

   ```sh
   cd ../cytoweave-site
   git add -A
   git commit -m "Update the website"
   git push
   ```

   GitHub Pages republishes within a minute or two.

Commit the page sources in this repository as usual; the built site is
committed only on `gh-pages`.

### First time on a new computer

Clone just the `gh-pages` branch, beside this repository:

```sh
git clone --branch gh-pages --single-branch git@github.com:robert-mcdermott/cytoweave.git ../cytoweave-site
```

The build only adds and replaces files. To remove a page, delete its
built file from the checkout as well.

## Writing pages

Each page starts with a front-matter block. The rest of the page is the
content only: the build adds the header, the documentation menu, the
previous/next links, the "On this page" list and the footer.

```html
---
title: Gating
description: One sentence for search engines and link previews.
lede: The paragraph under the title (documentation pages).
---
      <h2 id="draw">Drawing gates</h2>
      <p>…</p>
```

- Every `h2` needs an `id`. The "On this page" list is made from them, and
  other pages link to them (`gating.html#review`).
- `layout: page` (used by Install and Science) gives a top-level page the
  documentation column and its "On this page" list.
- Screenshots are written as:

  ```html
  <shot name="gate" alt="What the screenshot shows">The caption, which may contain HTML.</shot>
  ```

  This becomes a figure holding `docs/images/gate-dark.webp` and
  `gate-light.webp`, and the page shows the one matching its theme. Add
  `window` to draw it in a window frame (as on the home page), and `eager`
  for the first image on a page.
- `{{version}}` becomes the version in `main.go`, and `{{github}}` becomes
  the repository URL.
- To add a documentation page, create `pages/docs/<name>.html` and add it
  to `DOCS` at the top of `build.mjs`. That list sets the menu and the
  previous/next order.

## Screenshots

The screenshots are captured from the example experiments, in both themes,
by driving headless Chrome (or Chromium, Edge or Brave; set `CHROME` to
choose). The script builds CytoWeave from source and runs it with an empty
library, so every run gives the same pictures:

```sh
node docs/capture/capture.mjs                 # every scene, both themes
node docs/capture/capture.mjs gate compare    # some scenes
node docs/capture/capture.mjs gate --theme dark
```

Each scene is a function in `docs/capture/capture.mjs`. To add one, write
its function there, run it, and refer to it with `<shot name="…">`. The
README uses the same images. A scene's name is the name of its pictures
(`<scene>-light.webp`, `<scene>-dark.webp`), so the script refuses to run
when two scenes share a name.

`--audit` also checks every captured scene with axe-core (WCAG 2.1 A and AA)
and records the result in `docs/capture/audit.json`, which keeps every
scene's latest audit: capturing some scenes updates only theirs.

## For each release

1. Re-capture the screenshots if the interface has changed, and commit them.
2. Check the pages against what changed, especially the guide pages for
   new or changed features, and the version and highlights on the home
   page.
3. Build, preview and publish after the release is out. The site advertises
   the new version, and its install commands fetch the latest release.
