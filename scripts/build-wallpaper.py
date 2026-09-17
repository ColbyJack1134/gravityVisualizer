from pathlib import Path
from argparse import ArgumentParser
import json
import math
import re
import shutil
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
parser = ArgumentParser()
parser.add_argument('--preset', choices=['legacy'])
args = parser.parse_args()
suffix = '-legacy' if args.preset else ''
target = root / ('dist/wallpaper-engine' + suffix)
target.mkdir(parents=True, exist_ok=True)
page = (root / 'wallpaper/index.html').read_text()
project = json.loads((root / 'wallpaper/project.json').read_text())

def inline(match):
    script = (root / 'wallpaper' / match[1]).resolve()
    return '<script>\n' + script.read_text().replace('</script', '<\\/script') + '\n</script>'

page = re.sub(r'<script src="([^"]+)"></script>', inline, page)
if args.preset:
    preset = json.loads((root / 'presets' / (args.preset + '.json')).read_text())
    settings = preset['settings']
    properties = project['general']['properties']
    aliases = {
        'motionStrength': 'movement', 'roll': 'tilt', 'fadeSeconds': 'particlefade',
        'speed': 'timescale', 'count': 'particles', 'sustainStrength': 'sustainedamount',
        'shakeStrength': 'bassshake', 'balance': 'audiobalance', 'silenceThreshold': 'silencecutoff'
    }
    percentages = {'material', 'sharpness', 'starDefinition', 'brightnessMin', 'brightnessMax',
                   'radialDimming', 'cloudThickness', 'starDensity', 'cloudDensity', 'motionStrength',
                   'framing', 'framingY', 'sustainStrength', 'shakeStrength', 'balance', 'silenceThreshold'}
    for key, value in settings.items():
        prop = aliases.get(key, key.lower())
        if prop not in properties:
            continue
        if key in percentages:
            value = round(value * 100, 6)
        elif key == 'roll':
            value = round(math.degrees(value), 6)
        elif key == 'cloudRadius':
            value = round(value / .22, 6)
        if key == 'count':
            value = str(value)
        properties[prop]['value'] = value

    def color(hex_value):
        return ' '.join(f'{int(hex_value[i:i+2], 16) / 255:.9f}' for i in [1, 3, 5])

    for field, prefix in [('palette', ''), ('idlePalette', 'idle')]:
        palette = settings[field]
        properties[prefix + 'colormode']['value'] = palette['mode']
        properties[prefix + 'solidcolor']['value'] = color(palette['solid'])
        properties[prefix + 'saturation']['value'] = palette['saturation'] * 100
        for mode in ['hsv', 'custom', 'weighted']:
            gradient = palette[mode]
            for key, prop, scale in [('offset', 'offset', 100), ('speed', 'speed', 1), ('animated', 'animate', 1)]:
                value = gradient[key]
                properties[prefix + mode + prop]['value'] = value if isinstance(value, bool) else value * scale
            if 'stops' in gradient:
                properties[prefix + mode + 'count']['value'] = len(gradient['stops'])
                for i, stop in enumerate(gradient['stops'], 1):
                    properties[prefix + mode + 'color' + str(i)]['value'] = color(stop)
            for i, weight in enumerate(gradient.get('weights', []), 1):
                properties[prefix + mode + 'weight' + str(i)]['value'] = weight
    project['title'] = 'Gravity Legacy [Audio Visualizer]'
    project['description'] = 'The original cloud, camera angle, and lighting, with live audio response.'
    page = page.replace('GravityWallpaper.start();', 'GravityWallpaper.preset = ' + json.dumps(settings).replace('</', '<\\/') + ';\nGravityWallpaper.start();')
    page = page.replace('<title>Gravity [Audio Visualizer]</title>', '<title>' + project['title'] + '</title>')
    (target / 'preset.json').write_text(json.dumps(preset, indent=2) + '\n')

preview = root / 'wallpaper' / ('preview-legacy.gif' if args.preset else 'preview.gif')
project['preview'] = 'preview.gif'
(target / 'index.html').write_text(page)
(target / 'project.json').write_text(json.dumps(project, indent=2) + '\n')
shutil.copyfile(preview, target / project['preview'])
files = ['index.html', 'project.json', project['preview']]
if args.preset:
    files.append('preset.json')
archive_path = root / ('dist/gravity-wallpaper' + suffix + '.zip')
with ZipFile(archive_path, 'w', ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(target / name, name)
print(f'Built {target.relative_to(root)} and {archive_path.relative_to(root)}')
