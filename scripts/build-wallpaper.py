from pathlib import Path
import re
import shutil
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
target = root / 'dist/wallpaper-engine'
target.mkdir(parents=True, exist_ok=True)
page = (root / 'wallpaper/index.html').read_text()

def inline(match):
    script = (root / 'wallpaper' / match[1]).resolve()
    return '<script>\n' + script.read_text().replace('</script', '<\\/script') + '\n</script>'

page = re.sub(r'<script src="([^"]+)"></script>', inline, page)
(target / 'index.html').write_text(page)
for name in ['project.json', 'preview.jpg']:
    shutil.copyfile(root / 'wallpaper' / name, target / name)
with ZipFile(root / 'dist/gravity-wallpaper.zip', 'w', ZIP_DEFLATED) as archive:
    for name in ['index.html', 'project.json', 'preview.jpg']:
        archive.write(target / name, name)
print(f'Built {target.relative_to(root)} and dist/gravity-wallpaper.zip')
