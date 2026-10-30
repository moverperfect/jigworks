# index.html names the front end, and the app host serves it

A Build needs to know which files run in the browser and which stylesheets to compile. A Workspace with an `index.html` at its root has a front end, and that page names its parts, as Vite reads one: each `<script type="module" src="/src/...">` is bundled for the browser, and each `<link rel="stylesheet" href="/src/...">` is compiled. The Build points the page's links at what it made, such as `/client/main.js` for `src/client/main.tsx`. Links to files in `public/` are left alone. There's no other setting to keep in step, and the Agent already knows this shape from Vite.

The app host serves the Build's assets itself, in front of the Worker, routed as Cloudflare routes assets with the `assets` settings in `wrangler.jsonc`:

- a request that matches an asset gets it, unless `run_worker_first` covers its path;
- with `not_found_handling: "single-page-application"`, any other page navigation gets `index.html`;
- everything else goes to the Worker.

A stylesheet that imports `tailwindcss`, itself or through the Workspace's own stylesheets, goes through the platform's Tailwind (ADR 0007). Any other stylesheet is plain CSS, which the bundler combines with its `@import`s. That is the fallback ADR 0007 names, and it doesn't touch Tailwind at all.

## Consequences

- **A Workspace without `index.html` builds as before:** a Worker and nothing else. Adding one gives it a front end.
- **Linking a file that isn't there fails the Build,** at the line in `index.html`, rather than serving a page that can't load it.
- **Asset names carry no content hash,** so the app host sends `Cache-Control: no-cache` with an ETag, and the browser asks each time.
- **Only the `assets` settings above apply.** `html_handling`, `404-page`, redirects and custom headers are left at their defaults. `assets.directory` isn't needed, because the Build decides what the assets are.
- **Assets are text.** A binary file in `public/`, such as a PNG, would be served damaged. Such files are rare for now, because the Developer can't upload files.
- **A Tailwind upgrade changes every Build's hash,** so each Workspace's next Build compiles with the new version, even with no file changed.
