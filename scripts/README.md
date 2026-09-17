# Build and render

Install Node.js, Python 3, Chrome, and FFmpeg, then run:

```sh
npm ci
npm run build
npm run build:wallpaper
npm run build:legacy
```

The browser build is `gravity-demo.html`. Wallpaper Engine projects and ZIPs are written to `dist/`.

## Media

```sh
npm run render -- --music --output dist/media/gravity-demo-1080p60.mp4
npm run render -- --output dist/media/idle.mp4
npm run render -- --green --output dist/media/green.mp4
npm run render -- --preset presets/legacy.json --output dist/media/legacy.mp4
python3 scripts/previews.py idle
python3 scripts/previews.py music
python3 scripts/previews.py green
python3 scripts/previews.py legacy
```

Renders use Native quality at 1920×1080 and 60 FPS. Frames advance at a fixed rate, independent of rendering speed. The music render includes the full song, with two seconds of silence before it and three seconds after it. Other clips last eight seconds. `--seconds` limits a capture and `--fps 30` selects 30 FPS.

The preview script writes eight-second 1080p GIFs to `dist/media/`, four-second 640×360 gallery copies to `assets/previews/`, and 128×128 idle and Legacy thumbnails to `wallpaper/`. `--start` selects a different music excerpt. Rebuild both wallpaper packages after generating their thumbnails.

For an existing Chrome debugging session, set `GRAVITY_CDP` to its URL. `GRAVITY_URL` can override the browser build URL when Chrome runs on another host.

```sh
npm test
npm run test:presets
npm run test:stars-browser
npm run test:wallpaper-browser
```
