# Deník N CZ audio page

Static GitHub Pages site that collects article MP3 links from Deník N and publishes a simple audio player.

## What it does

- reads recent article URLs from the Deník N RSS feed
- downloads article HTML
- extracts the main article MP3 from `<audio><source src="...">`
- ignores `predplatne.mp3`
- writes `docs/data/articles.json`
- serves a static page from `docs/`
- refreshes every day via GitHub Actions

## Repository layout

- `.github/workflows/update-audio.yml` - daily scheduled workflow
- `scripts/build.py` - fetches RSS + extracts MP3 URLs + writes JSON
- `requirements.txt` - Python dependencies for the workflow
- `docs/` - static website published by GitHub Pages

## Setup

1. Create a new GitHub repository.
2. Upload these files.
3. In GitHub, open **Settings -> Pages**.
4. Set **Build and deployment** to **Deploy from a branch**.
5. Select branch **main** and folder **/docs**.
6. Save.
7. In **Actions**, run the `Update Deník N audio index` workflow once manually.

After that, your site will be available at:

- `https://<your-user>.github.io/<repo-name>/`

## Notes

- The workflow is scheduled daily and can also be run manually.
- The scraper prefers the real article MP3 and excludes `predplatne.mp3`.
- The site only lists items where a valid article MP3 was found.
