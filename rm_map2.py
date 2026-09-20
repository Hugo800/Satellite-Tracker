import re

with open('app.js', 'r') as f:
    app = f.read()

# Remove MapRenderer.draw()
app = re.sub(r'\s*MapRenderer\.draw\(\);', '', app)

# Find and remove MapRenderer object
idx = app.find('const MapRenderer = {')
if idx != -1:
    # Also remove the comment block before it
    comment_idx = app.rfind('MAP RENDERER', 0, idx)
    if comment_idx != -1:
        start_idx = app.rfind('/*', 0, comment_idx)
    else:
        start_idx = idx
    app = app[:start_idx]

with open('app.js', 'w') as f:
    f.write(app)
