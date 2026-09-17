# Gravity Visualizer

A black hole audio visualizer for Wallpaper Engine and the browser.

[Wallpaper](https://steamcommunity.com/sharedfiles/filedetails/?id=3802507065) · [Browser demo](https://colbyjack1134.github.io/gravityVisualizer/) · [1080p60 video](https://github.com/ColbyJack1134/gravityVisualizer/releases/download/v0.2.0/gravity-demo-1080p60.mp4)

[![Idle star colors](assets/previews/idle.gif)](https://github.com/ColbyJack1134/gravityVisualizer/releases/download/v0.2.0/idle-1080p.gif)

[![HSV colors reacting to music](assets/previews/music.gif)](https://github.com/ColbyJack1134/gravityVisualizer/releases/download/v0.2.0/music-1080p.gif)

[![Custom green gradient in idle](assets/previews/green.gif)](https://github.com/ColbyJack1134/gravityVisualizer/releases/download/v0.2.0/green-1080p.gif)

[![Legacy preset](assets/previews/legacy.gif)](https://github.com/ColbyJack1134/gravityVisualizer/releases/download/v0.2.0/legacy-1080p.gif)

Click a preview for the 1920×1080 GIF. All captures use Native rendering quality; the video includes the full demo song with two seconds of silence before it and three seconds after it.

## Wallpaper Engine

Download the [current preset](https://github.com/ColbyJack1134/gravityVisualizer/releases/download/v0.2.0/gravity-wallpaper.zip) or [Legacy preset](https://github.com/ColbyJack1134/gravityVisualizer/releases/download/v0.2.0/gravity-wallpaper-legacy.zip). Extract the ZIP, then open its `index.html` in the Wallpaper Engine editor to publish it. Each package includes an animated preview.

Legacy restores the saved camera angle, cloud, and lighting settings. Both presets remain customizable.

## Details

Built with JavaScript and WebGL2. Particle orbits and gravitational lensing use the Kerr metric, with approximate volume rendering for the glowing disk. Supports live system audio in Wallpaper Engine, plus local music and browser-supported audio sharing on the web.

[Build and render instructions](scripts/README.md)

## Credits

Demo music: [Chill Day by LAKEY INSPIRED](assets/CREDITS.md), licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

The rendered demo video is also licensed under CC BY-SA 3.0.
