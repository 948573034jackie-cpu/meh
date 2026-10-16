// Bundles the app into ONE self-contained HTML file: dist/line-trainer.html
// Run: node build.js
const fs = require('fs');
const path = require('path');
const r = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'src/icon180.png')).toString('base64');
const safe = s => s.replace(/<\/script/gi, '<\\/script');
const html = r('src/index.html')
  .replace(/__ICON__/g, () => icon)
  .replace('/*__CSS__*/', () => r('src/app.css'))
  .replace('/*__CORE__*/', () => safe(r('../spotify-line-trainer/src/core.js')))
  .replace('/*__APP__*/', () => safe(r('src/app.js')));
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/line-trainer.html'), html);
console.log('wrote dist/line-trainer.html', Math.round(html.length / 1024) + ' KB');
