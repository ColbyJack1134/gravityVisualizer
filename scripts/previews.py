from argparse import ArgumentParser
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
parser = ArgumentParser()
parser.add_argument('scene', choices=['idle', 'music', 'green', 'legacy'])
parser.add_argument('--source', type=Path)
parser.add_argument('--start', type=float)
args = parser.parse_args()
scene = args.scene
source = args.source or root / 'dist/media' / ('gravity-demo-1080p60.mp4' if scene == 'music' else scene + '.mp4')
start = args.start if args.start is not None else (47 if scene == 'music' else 0)
gallery = root / 'assets/previews'
gallery.mkdir(parents=True, exist_ok=True)

def gif(target, transform, fps, seconds, colors=256):
    filters = f'fps={fps},{transform},split[frames][colors];[colors]palettegen=max_colors={colors}:reserve_transparent=0[palette];[frames][palette]paletteuse=dither=none'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(start), '-t', str(seconds),
                    '-i', str(source), '-filter_complex', filters, '-loop', '0', str(target)], check=True)
    print(f'{target.relative_to(root)}: {target.stat().st_size / 1048576:.2f} MiB', flush=True)

gif(root / 'dist/media' / (scene + '-1080p.gif'), 'scale=1920:1080:flags=lanczos', 20, 8)
gallery_target = gallery / (scene + '.gif')
gif(gallery_target, 'scale=480:270:flags=lanczos', 8, 4, 128)
if gallery_target.stat().st_size >= 2000000:
    raise RuntimeError('Gallery preview exceeds 2 MB.')
if scene in ['idle', 'legacy']:
    target = root / 'wallpaper' / ('preview.gif' if scene == 'idle' else 'preview-legacy.gif')
    gif(target, 'crop=ih:ih,scale=128:128:flags=lanczos', 20, 4)
    if target.stat().st_size >= 1000000:
        raise RuntimeError('Thumbnail exceeds the Workshop preview size limit.')
