import re

with open('index.html', 'r') as f:
    html = f.read()
# Remove Map button
html = re.sub(r'<button id="btnToggleMap".*?</button>', '', html, flags=re.DOTALL)
# Remove Map canvas
html = re.sub(r'<canvas id="mapCanvas"></canvas>', '', html)
with open('index.html', 'w') as f:
    f.write(html)

with open('style.css', 'r') as f:
    css = f.read()
# Remove map styles
css = re.sub(r'#mapCanvas\s*\{[^}]*\}', '', css)
css = re.sub(r'#mapCanvas\.active\s*\{[^}]*\}', '', css)
css = re.sub(r'body\.map-view #skyCanvas,\s*body\.map-view #radarContainer\s*\{[^}]*\}', '', css)
css = re.sub(r'body\.map-view #mapCanvas\s*\{[^}]*\}', '', css)
with open('style.css', 'w') as f:
    f.write(css)

with open('app.js', 'r') as f:
    app = f.read()
# Remove mapMode from State
app = re.sub(r'\s*mapMode:\s*false,', '', app)
# Remove btnToggleMap event listener
app = re.sub(r'\s*document\.getElementById\(\'btnToggleMap\'\)\.addEventListener.*?\}\);', '', app, flags=re.DOTALL)
# Remove MapRenderer.init()
app = re.sub(r'\s*MapRenderer\.init\(\);', '', app)
# Remove MapRenderer.draw()
app = re.sub(r'\s*if\s*\(State\.mapMode\)\s*MapRenderer\.draw\(\);', '', app)
# Remove MapRenderer object
app = re.sub(r'/\*\s*═══════════════════════════════════════════════════════════════\s*MAP RENDERER\s*═══════════════════════════════════════════════════════════════ \*/.*?const MapRenderer = \{.*?^\};\n', '', app, flags=re.DOTALL|re.MULTILINE)

with open('app.js', 'w') as f:
    f.write(app)
