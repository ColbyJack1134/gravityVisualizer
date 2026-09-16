from base64 import b64encode
from pathlib import Path

root = Path(__file__).resolve().parents[1]
page = (root / 'index.html').read_text()
page = page.replace('<link rel="stylesheet" href="src/style.css">', '<style>\n' + (root / 'src/style.css').read_text() + '\n</style>')
audio = b64encode((root / 'assets/chill-day.mp3').read_bytes()).decode('ascii')
page = page.replace('src="assets/chill-day.mp3"', f'src="data:audio/mpeg;base64,{audio}"')
for name in ['physics', 'audio', 'palette', 'shaders', 'app', 'web']:
    script = (root / f'src/{name}.js').read_text().replace('</script', '<\\/script')
    page = page.replace(f'<script src="src/{name}.js"></script>', '<script>\n' + script + '\n</script>')
target = root / 'gravity-demo.html'
target.write_text(page)
print(f'Built {target.name} ({target.stat().st_size:,} bytes)')
