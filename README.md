# Wave Watch

Wave Watch is a static surf forecast site built for GitHub Pages.

It generates a **14-day forecast dataset at build time**, then ships a client app that reads only the generated JSON. No browser-time fallback data, no fake samples.

## What it does

- builds a 14-day forecast for curated surf spots
- blends multiple public wave forecast solutions
- blends multiple weather forecast solutions for wind/temperature
- attaches buoy observations where available for quick reality checks
- exposes the generated forecast JSON directly in the deployed site
- deploys automatically to GitHub Pages
- refreshes on a GitHub Actions cron every 6 hours

## Model stack

### Wave guidance

- ECMWF WAM
- NCEP GFS-Wave
- Météo-France Wave

### Weather guidance

- ECMWF IFS
- NOAA GFS

## Data / truth sources for continued improvement

- NDBC buoy observations
- NOAA WAVEWATCH III / GEFS-Wave archives
- ERA5 wave reanalysis
- CDIP nearshore archives

See `docs/modeling-roadmap.md` for the next iteration path.

## Local development

Install dependencies:

```bash
npm install
```

Refresh the generated dataset:

```bash
npm run build:data
```

Start the app:

```bash
npm run dev
```

## Production build

```bash
npm run build
```

That command:

1. fetches live forecast data
2. generates `public/data/forecast-data.json`
3. builds the Vite app for GitHub Pages

## GitHub Pages + cron

The workflow in `.github/workflows/pages.yml`:

- runs on pushes to `main`
- runs manually via `workflow_dispatch`
- reruns every 6 hours via cron
- rebuilds forecast data and redeploys the Pages site

## Important note

Because this app uses live public APIs during the build, a deploy can fail if an upstream data source is temporarily unavailable. That is intentional right now: the site should fail loudly rather than silently ship fake fallback forecast data.
