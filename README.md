# Inspirit AI Projects Catalog

The public gallery of student independent-research projects, live at
**<https://research.inspiritai.com>**.

Project content is pulled from Airtable at build time and rendered to static
HTML — one page per project under `/projects/<project_id>.html`, plus the
catalog index and a "published work" view.

## Deployment

Hosted on Vercel as the `project-gallery` project in the **Inspirit AI** team,
connected to this repo. **Every push to `main` triggers a production deploy**,
and each deploy re-runs `getData.js`, so a deploy is also a data refresh.

To publish newly approved Airtable projects without any code change, push an
empty commit:

```bash
./reloadWebsite.sh
```

The build runs `npm run prod-hydrate` (`getData.js` → `optimizeImages.js` → `webpack`) and publishes
`dist/`. Routing, the `data.json` content type, and the SPA fallback are
configured in `vercel.json`.

> This site was previously hosted on Netlify at
> `independent-project-mentorship.netlify.app`. That deployment is retired.

## Local development

```bash
npm install
npm run prod-hydrate
```

`npm run watch` rebuilds on change once `data.json` exists (it regenerates the
resized WebP variants first - `optimizeImages.js` writes them next to the originals
plus `image-manifest.json`; only the variants ship, see `webpack.config.js`).

## Environment

`getData.js` needs these in a local `.env` (and they are already set on Vercel
for Production, Preview, and Development):

| Variable | Purpose |
| --- | --- |
| `AIRTABLE_API_KEY` | Airtable auth |
| `AIRTABLE_BASE_ID` | Base holding project records |
| `AIRTABLE_BASE_PROJECTS_NAME` | Projects table name |
| `AIRTABLE_BASE_DOMAINS_NAME` | Domains table name |
| `GOOGLE_API_KEY` | Resolving Google Drive attachment links |

**Note:** values in `.env` are wrapped in double quotes. `dotenv` strips those
automatically, so anything that copies `.env` into another system (Vercel env
vars, CI) must strip them too — otherwise Airtable returns a 404.

`data.json` is generated and git-ignored. `dist/` is committed as a fallback,
but Vercel rebuilds it from source on every deploy.
