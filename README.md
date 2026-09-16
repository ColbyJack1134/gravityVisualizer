# Gravity Visualizer

A WebGL2 black hole visualizer with a tilted particle disk and local music playback.

## Run

Open **`gravity-demo.html`** in desktop Chrome or Edge with graphics acceleration enabled. No server or installation is needed.

**Controls** and **Fullscreen** sit in the lower left. **Cipher** by Kevin MacLeod is the default demo track and starts paused. Open Controls and press play, or use **Choose music** to load your own local file without uploading it. [Music credit and license](assets/CREDITS.md).

## Controls

- **Audio:** 24 frequency bands control how many particles are visible. Adjust sensitivity, band balance, sustained amount, and bass shake. Three seconds of silence starts a six-second return to idle brightness.
- **Colors:** solid color, HSV gradient, or a custom gradient with 2–6 stops. Gradients support offset and animation in either direction.
- **Background:** independent star and cloud density, from 0–500%.
- **Camera:** slow orbit, music-driven orbit, or hold; movement, tilt, framing, elevation, and distance.
- **Black hole:** spinning or non-spinning.
- **Material & light:** material, exposure, sharpness, particle fade, and time scale.
- **Performance:** particle count, render quality, frame cap, and live stats.

Defaults include 65,536 particles, Balanced quality, a 60 FPS cap, spin 0.25, elevation 18°, distance 37, tilt 15°, framing 3 / 10, material 30%, exposure 1.7, sharpness 100%, three-second fades, and 10× time scale. Gradient animation starts enabled.

Scene **Pause** freezes trajectories, camera movement, and gradient animation. Music and its visibility response continue; pause the player to stop the music. Settings last for the open page session.

## Rendering

Light and independent particles follow numerical geodesics in fixed Kerr spacetime. The horizon is analytic; the visible shadow comes from traced ray capture. Emission and finite-resolution volume rendering are approximations. There are no plasma dynamics or forces between particles.

The renderer caches light paths and reuses them during camera orbit. Its floating-point volume and path textures need substantial GPU memory. All quality levels cap internal resolution, including Native / maximum.

[Physics](docs/physics.md) · [Audio](docs/audio.md) · [Performance](docs/performance.md) · [Wallpaper Engine handoff](docs/handoff.md)

## Development

```sh
python3 scripts/build.py
npm test
```

Browser checks require Node 20+, `npm ci`, and installed Chrome:

```sh
npm run test:browser
npm run test:audio-browser
npm run test:response-browser
npm run test:background-browser
npm run test:material-browser
npm run test:features-browser
```

Use `npm run benchmark` for additional viewport measurements. Set `GRAVITY_CHANNEL=msedge` for Edge, or `GRAVITY_CDP=http://127.0.0.1:PORT` to attach to a test browser. `GRAVITY_URL=file:///.../gravity-demo.html` overrides the page location. Results and screenshots go to the ignored `test-results/` directory.

Edit `index.html` and `src/`, then rebuild the standalone file. The build embeds `assets/cipher.mp3` alongside the code, so the demo works offline as one HTML file. It has no runtime library dependencies. [Research references and recovered wallpapers](research/findings.md) are kept separately.

For the development page with separate files, run `python3 -m http.server 8000 --bind 127.0.0.1` and open `http://localhost:8000/`. Chrome blocks audio analysis of a separate MP3 when `index.html` is opened through `file://`; the standalone build avoids this by embedding the song.

For static hosting, serve the built `gravity-demo.html` as `index.html`. Only that file is required; development files, research, and Git metadata do not belong in the site output.
