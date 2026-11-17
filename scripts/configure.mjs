// One-time setup for a fresh clone. Review the diff before deployment.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.join(root, 'site.config.local.json');
if (!fs.existsSync(configPath)) {
  console.error('Copy site.config.example.json to site.config.local.json and fill in your own values.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const required = ['firebaseProjectId', 'hostingSiteId', 'siteDomain', 'firebaseWebApiKey', 'firebaseSenderId', 'firebaseAppId'];
for (const key of required) {
  if (!cfg[key] || String(cfg[key]).startsWith('YOUR_') || String(cfg[key]).startsWith('your-') || cfg[key] === 'blog.example.com') {
    console.error(`Set ${key} in site.config.local.json.`);
    process.exit(1);
  }
}
if (!/^[a-z0-9.-]+$/i.test(cfg.siteDomain) || !/^[a-z0-9-]+$/i.test(cfg.firebaseProjectId)) {
  console.error('Invalid domain or Firebase project ID.');
  process.exit(1);
}
const substitutions = new Map([
  ['your-firebase-project', cfg.firebaseProjectId],
  ['your-blog', cfg.hostingSiteId],
  ['blog.example.com', cfg.siteDomain],
  ['blog\\.example\\.com', cfg.siteDomain.replaceAll('.', '\\.')],
  ['https://www.example.com', `https://www.${cfg.companyDomain || cfg.siteDomain}`],
  ['https://example.com', `https://${cfg.companyDomain || cfg.siteDomain}`],
  ['www\\.example\\.com', `www\\.${(cfg.companyDomain || cfg.siteDomain).replaceAll('.', '\\.')}`],
  ['example\\.com', (cfg.companyDomain || cfg.siteDomain).replaceAll('.', '\\.')],
  ['YOUR_FIREBASE_WEB_API_KEY', cfg.firebaseWebApiKey],
  ['YOUR_FIREBASE_SENDER_ID', cfg.firebaseSenderId],
  ['YOUR_FIREBASE_APP_ID', cfg.firebaseAppId],
  ['YOUR_INSTAGRAM_BUSINESS_ID', cfg.instagramBusinessId || 'YOUR_INSTAGRAM_BUSINESS_ID'],
  ['YOUR_META_PAGE_ID', cfg.metaPageId || 'YOUR_META_PAGE_ID'],
  ['YOUR_WHATSAPP_NUMBER', cfg.whatsappNumber || 'YOUR_WHATSAPP_NUMBER'],
  ['YOUR_META_PIXEL_ID', cfg.metaPixelId || 'YOUR_META_PIXEL_ID'],
  ['your-supabase-project', cfg.supabaseProjectRef || 'your-supabase-project'],
  ['YOUR_SUPABASE_PUBLISHABLE_KEY', cfg.supabasePublishableKey || 'YOUR_SUPABASE_PUBLISHABLE_KEY'],
  ['YOUR_APPS_SCRIPT_DEPLOYMENT_ID', cfg.appsScriptDeploymentId || 'YOUR_APPS_SCRIPT_DEPLOYMENT_ID'],
]);
const extensions = new Set(['.js', '.html', '.css', '.json', '.txt', '.rules', '.svg']);
const skip = new Set(['node_modules', '.git', '.firebase', 'docs']);
const pattern = new RegExp([...substitutions.keys()].sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
let changed = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!extensions.has(path.extname(file)) || file === configPath || file.endsWith('.example.json') || file.endsWith('configure.mjs')) continue;
    let content = fs.readFileSync(file, 'utf8');
    let next = content;
    next = next.replace(pattern, token => String(substitutions.get(token)));
    if (next !== content) { fs.writeFileSync(file, next); changed++; }
  }
}
walk(root);
fs.writeFileSync(path.join(root, '.firebaserc'), JSON.stringify({ projects: { default: cfg.firebaseProjectId }, targets: {} }, null, 2) + '\n');
// IndexNow requires a separate proof file hosted at the domain root.
if (cfg.enableIndexNow) {
  const key = crypto.randomBytes(16).toString('hex');
  const indexNow = path.join(root, 'functions', 'indexnow.js');
  fs.writeFileSync(indexNow, fs.readFileSync(indexNow, 'utf8').replace('YOUR_INDEXNOW_KEY', key));
  fs.writeFileSync(path.join(root, 'public', `${key}.txt`), key);
}
console.log(`Configured ${changed} files. Review git diff and set up secrets before deploying.`);
