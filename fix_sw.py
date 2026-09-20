import re

with open('index.html', 'r') as f:
    html = f.read()

target = """  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(r => console.log('SW registered, scope:', r.scope))
      .catch(e => console.error('SW error:', e));
  }"""

repl = """  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      console.log('SW registered, scope:', reg.scope);
    }).catch(e => console.error('SW error:', e));

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }"""

html = html.replace(target, repl)

with open('index.html', 'w') as f:
    f.write(html)
