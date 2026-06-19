/**
 * Silicon Wives — Swipe App
 * Shopify Embedded App (OAuth + Admin UI + Storefront API)
 */
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

// ── Config ──────────────────────────────────────────────────────────────────
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY    || '';
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const APP_URL            = process.env.APP_URL            || `http://localhost:${PORT}`;
const SCOPES             = 'read_products,read_inventory,write_script_tags';
const CONFIG_FILE        = path.join(__dirname, '../data/config.json');
const DATA_DIR           = path.join(__dirname, '../data');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SHOPIFY_API_SECRET || 'sw-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Serve static public files
app.use('/public', express.static(path.join(__dirname, '../public')));

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadConfig(shop) {
  const file = shopConfigFile(shop);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  }
  return defaultConfig();
}

function saveConfig(shop, config) {
  config.last_updated = new Date().toISOString();
  fs.writeFileSync(shopConfigFile(shop), JSON.stringify(config, null, 2));
}

function shopConfigFile(shop) {
  const safe = (shop || 'default').replace(/[^a-z0-9-]/gi, '_');
  return path.join(DATA_DIR, `config_${safe}.json`);
}

function defaultConfig() {
  return {
    filters: {
      excluded_types: ['custom option', 'Head', 'Apparel & Accessories', 'Torso', 'Clearance'],
      excluded_ids: [],
      min_price: 0,
      max_price: 3899
    },
    sort_mode: 'smart',
    product_order: [],
    pinned_positions: {},
    boosts: [],
    suppressed: [],
    last_updated: null
  };
}

function getShopToken(shop) {
  const file = path.join(DATA_DIR, `token_${(shop||'').replace(/[^a-z0-9-]/gi,'_')}.txt`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return null;
}

function saveShopToken(shop, token) {
  const file = path.join(DATA_DIR, `token_${(shop||'').replace(/[^a-z0-9-]/gi,'_')}.txt`);
  fs.writeFileSync(file, token);
}

function verifyHmac(query) {
  const { hmac, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(msg).digest('hex');
  return digest === hmac;
}

async function shopifyGet(shop, token, endpoint) {
  const url = `https://${shop}/admin/api/2024-01/${endpoint}`;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function shopifyGraphQL(shop, token, query) {
  const url = `https://${shop}/admin/api/2024-01/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error(`GraphQL error: ${res.status}`);
  return res.json();
}

// ── OAuth ────────────────────────────────────────────────────────────────────

// Step 1: Begin OAuth
app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const redirectUri = `${APP_URL}/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${redirectUri}&state=${state}`;

  res.redirect(installUrl);
});

// Step 2: OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  // Verify state
  if (state !== req.session.oauthState) {
    return res.status(403).send('State mismatch — possible CSRF attack');
  }

  // Verify HMAC
  if (!verifyHmac(req.query)) {
    return res.status(403).send('HMAC verification failed');
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(400).send('Failed to get access token: ' + JSON.stringify(tokenData));
    }

    // Save token
    saveShopToken(shop, accessToken);
    req.session.shop = shop;
    req.session.token = accessToken;

    console.log(`[Auth] Installed on ${shop}`);
    res.redirect(`/admin?shop=${shop}`);
  } catch (err) {
    console.error('[Auth] Error:', err);
    res.status(500).send('OAuth error: ' + err.message);
  }
});

// ── Auth middleware for admin routes ─────────────────────────────────────────
function requireAuth(req, res, next) {
  const shop = req.query.shop || req.body?.shop || req.session.shop;
  const token = getShopToken(shop) || req.session.token;
  if (!shop || !token) {
    // For API calls return JSON error, for page loads redirect
    const isApi = req.path.startsWith('/api/');
    if (isApi) return res.status(401).json({ error: 'Not authenticated', shop });
    return res.redirect(`/auth?shop=${shop || ''}`);
  }
  req.shop = shop;
  req.token = token;
  next();
}

// ── Admin UI ─────────────────────────────────────────────────────────────────
app.get('/admin', requireAuth, (req, res) => {
  res.send(buildAdminHTML(req.shop));
});

// ── Admin API ─────────────────────────────────────────────────────────────────

// GET config
app.get('/api/config', requireAuth, (req, res) => {
  res.json(loadConfig(req.shop));
});

// POST config (save + return updated)
app.post('/api/config', requireAuth, (req, res) => {
  const config = loadConfig(req.shop);
  const data = req.body;
  const mergeKeys = ['sort_mode', 'product_order', 'pinned_positions', 'boosts', 'suppressed'];
  mergeKeys.forEach(k => { if (k in data) config[k] = data[k]; });
  if (data.filters) config.filters = data.filters;
  saveConfig(req.shop, config);
  res.json({ success: true, config });
});

// GET products — fetch live from Shopify with smart ordering
app.get('/api/products', requireAuth, async (req, res) => {
  try {
    const products = await fetchAllProducts(req.shop, req.token);
    const config = loadConfig(req.shop);
    const filtered = applyConfig(products, config);
    res.json({ products: filtered, total: filtered.length, all_total: products.length });
  } catch (err) {
    console.error('[Products] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST sync — fetch fresh from Shopify, compute smart order, save
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    console.log(`[Sync] Starting for ${req.shop}...`);
    const products = await fetchAllProducts(req.shop, req.token);

    // Compute smart order
    const smartOrder = computeSmartOrder(products);
    const config = loadConfig(req.shop);
    config.product_order = smartOrder;
    config.sort_mode = 'smart';
    saveConfig(req.shop, config);

    // Cache products
    const cacheFile = path.join(DATA_DIR, `products_${req.shop.replace(/[^a-z0-9]/gi,'_')}.json`);
    fs.writeFileSync(cacheFile, JSON.stringify(products));

    console.log(`[Sync] Done — ${products.length} products, smart order computed`);
    res.json({ success: true, total: products.length });
  } catch (err) {
    console.error('[Sync] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST config reset
app.post('/api/config/reset', requireAuth, (req, res) => {
  saveConfig(req.shop, defaultConfig());
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// GET swipe app HTML — served directly to storefront
app.get('/swipe', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop');
  const token = getShopToken(shop);
  if (!token) return res.status(403).send('App not installed on this store');

  try {
    const products = await fetchAllProducts(shop, token);
    const config = loadConfig(shop);
    const filtered = applyConfig(products, config);
    const smartOrder = config.product_order || [];
    const adminCfg = {
      pinned_positions: config.pinned_positions || {},
      boosts: config.boosts || [],
      suppressed: config.suppressed || []
    };
    const html = buildSwipeHTML(filtered, smartOrder, adminCfg, shop);
    res.send(html);
  } catch (err) {
    console.error('[Swipe] Error:', err);
    res.status(500).send('Error loading swipe app: ' + err.message);
  }
});

// GET swipe app data as JSON (for iframe/embed use)
app.get('/api/swipe-data', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: 'Missing shop' });
  const token = getShopToken(shop);
  if (!token) return res.status(403).json({ error: 'Not installed' });

  try {
    const products = await fetchAllProducts(shop, token);
    const config = loadConfig(shop);
    const filtered = applyConfig(products, config);
    res.json({
      products: filtered,
      smart_order: config.product_order || [],
      admin_config: {
        pinned_positions: config.pinned_positions || {},
        boosts: config.boosts || [],
        suppressed: config.suppressed || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root — redirect to install or admin
app.get('/', (req, res) => {
  if (req.query.shop) return res.redirect(`/auth?shop=${req.query.shop}`);
  res.send(buildInstallHTML());
});

// ── Shopify Product Fetching ──────────────────────────────────────────────────

async function fetchAllProducts(shop, token) {
  // Check cache (max 1 hour old)
  const cacheFile = path.join(DATA_DIR, `products_${shop.replace(/[^a-z0-9]/gi,'_')}.json`);
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 60 * 60 * 1000) { // 1 hour cache
      try {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      } catch(e) {}
    }
  }

  // Fetch fresh
  const allRaw = [];
  let url = `https://${shop}/admin/api/2024-01/products.json?limit=250&status=active&fields=id,title,handle,images,variants,product_type,vendor,tags,body_html`;
  let page = 1;

  while (url) {
    console.log(`  [Fetch] Page ${page} (${allRaw.length} so far)...`);
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    const data = await res.json();
    allRaw.push(...(data.products || []));

    const link = res.headers.get('Link') || '';
    url = null;
    if (link.includes('rel="next"')) {
      for (const part of link.split(',')) {
        if (part.includes('rel="next"')) {
          url = part.trim().split(';')[0].trim().replace(/[<>]/g, '');
          break;
        }
      }
    }
    page++;
    if (url) await sleep(200);
  }

  // Fetch video media via GraphQL
  const videoMap = await fetchVideoMedia(shop, token, allRaw.map(p => p.id));

  // Slim down products
  const slimmed = allRaw.map(p => {
    const variant = p.variants?.[0] || {};
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      type: p.product_type || '',
      vendor: p.vendor || '',
      tags: (p.tags || ''),
      price: variant.price || '0',
      compare_at: variant.compare_at_price || null,
      variant_id: variant.id,
      image: p.images?.[0]?.src || '',
      images: (p.images || []).slice(0, 8).map(i => i.src),
      body_html: p.body_html || '',
      video_urls: videoMap[p.id] || []
    };
  });

  fs.writeFileSync(cacheFile, JSON.stringify(slimmed));
  return slimmed;
}

async function fetchVideoMedia(shop, token, productIds) {
  const videoMap = {};
  const batchSize = 50;
  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    const query = `{
      nodes(ids: [${batch.map(id => `"gid://shopify/Product/${id}"`).join(',')}]) {
        ... on Product {
          id
          media(first: 10) {
            nodes {
              mediaContentType
              ... on Video {
                sources { url mimeType fileSize }
              }
            }
          }
        }
      }
    }`;
    try {
      const data = await shopifyGraphQL(shop, token, query);
      for (const node of (data?.data?.nodes || [])) {
        if (!node?.id) continue;
        const numId = parseInt(node.id.split('/').pop());
        const videos = [];
        for (const m of (node.media?.nodes || [])) {
          if (m.mediaContentType === 'VIDEO') {
            const best = (m.sources || [])
              .filter(s => s.mimeType === 'video/mp4')
              .sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0))[0];
            if (best?.url) videos.push(best.url);
          }
        }
        if (videos.length) videoMap[numId] = videos;
      }
    } catch(e) {
      console.warn(`[Video] GraphQL batch error:`, e.message);
    }
    await sleep(200);
  }
  return videoMap;
}

// ── Smart Order & Config ──────────────────────────────────────────────────────

function computeSmartOrder(products) {
  return products
    .map(p => ({
      id: p.id,
      score: (parseFloat(p.compare_at || 0) > parseFloat(p.price || 0) ? 100 : 0) +
             (p.images?.length || 0) * 10
    }))
    .sort((a, b) => b.score - a.score)
    .map(p => p.id);
}

function applyConfig(products, config) {
  const filters = config.filters || {};
  const excludedIds = new Set(filters.excluded_ids || []);
  const excludedTypes = new Set(filters.excluded_types || []);
  const minPrice = parseFloat(filters.min_price || 0);
  const maxPrice = parseFloat(filters.max_price || 999999);
  const suppressed = new Set((config.suppressed || []).map(Number));
  const pinned = config.pinned_positions || {};

  let result = products.filter(p => {
    if (excludedIds.has(p.id)) return false;
    if (excludedTypes.has(p.type)) return false;
    if ((p.title || '').toLowerCase().includes('shipping protection')) return false;
    const price = parseFloat(p.price || 0);
    if (price < minPrice || price > maxPrice) return false;
    return true;
  });

  // Sort
  const order = config.product_order || [];
  if (order.length && config.sort_mode !== 'price_asc' && config.sort_mode !== 'price_desc') {
    const orderMap = Object.fromEntries(order.map((id, i) => [id, i]));
    result.sort((a, b) => (orderMap[a.id] ?? 99999) - (orderMap[b.id] ?? 99999));
  } else if (config.sort_mode === 'price_asc') {
    result.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  } else if (config.sort_mode === 'price_desc') {
    result.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  }

  // Suppressed to end
  if (suppressed.size) {
    const normal = result.filter(p => !suppressed.has(Number(p.id)));
    const sup = result.filter(p => suppressed.has(Number(p.id)));
    result = [...normal, ...sup];
  }

  // Pinned positions (1-based) — only if product in filtered set
  const sortedPins = Object.entries(pinned).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  for (const [posStr, pid] of sortedPins) {
    const pos = parseInt(posStr) - 1;
    const numPid = Number(pid);
    const existingIdx = result.findIndex(p => Number(p.id) === numPid);
    if (existingIdx >= 0) {
      const [pinnedProduct] = result.splice(existingIdx, 1);
      result.splice(Math.min(pos, result.length), 0, pinnedProduct);
    }
  }

  return result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTML Builders ─────────────────────────────────────────────────────────────

function buildInstallHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Silicon Wives — Swipe App</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #fdf4f8; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; }
    .box { background: white; border-radius: 16px; padding: 40px; text-align: center;
           box-shadow: 0 4px 24px rgba(233,30,140,0.12); max-width: 400px; }
    h1 { color: #e91e8c; margin: 0 0 8px; }
    p { color: #666; margin: 0 0 24px; }
    input { width: 100%; padding: 12px 16px; border: 1.5px solid #e0c4d4; border-radius: 8px;
            font-size: 15px; margin-bottom: 12px; box-sizing: border-box; outline: none; }
    input:focus { border-color: #e91e8c; }
    button { background: linear-gradient(135deg, #e91e8c, #ff6b6b); color: white; border: none;
             border-radius: 8px; padding: 12px 24px; font-size: 15px; font-weight: 600;
             cursor: pointer; width: 100%; }
  </style>
</head>
<body>
  <div class="box">
    <h1>💕 Silicon Wives</h1>
    <p>Swipe App — Enter your store URL to install</p>
    <input id="shop" type="text" placeholder="your-store.myshopify.com">
    <button onclick="install()">Install App</button>
  </div>
  <script>
    function install() {
      var shop = document.getElementById('shop').value.trim();
      if (!shop) return alert('Enter your store URL');
      if (!shop.includes('.myshopify.com')) shop += '.myshopify.com';
      window.location = '/auth?shop=' + encodeURIComponent(shop);
    }
  </script>
</body>
</html>`;
}

function buildSwipeHTML(products, smartOrder, adminConfig, shop) {
  const productsJson = JSON.stringify(products).replace(/<\//g, '<\\/');
  const smartOrderJson = JSON.stringify(smartOrder);
  const adminConfigJson = JSON.stringify(adminConfig);

  // Read the swipe UI template
  const templatePath = path.join(__dirname, '../public/swipe-template.html');
  if (fs.existsSync(templatePath)) {
    let html = fs.readFileSync(templatePath, 'utf8');
    html = html.replace('__PRODUCTS_JSON__', productsJson);
    html = html.replace('__SMART_ORDER_JSON__', smartOrderJson);
    html = html.replace('__ADMIN_CONFIG_JSON__', adminConfigJson);
    html = html.replace('__SHOP__', shop);
    return html;
  }
  return '<h1>Swipe template not found</h1>';
}

function buildAdminHTML(shop) {
  return fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8')
    .replace(/__SHOP__/g, shop);
}

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Silicon Wives Swipe App running on port ${PORT}`);
  console.log(`   App URL:   ${APP_URL}`);
  console.log(`   Admin:     ${APP_URL}/admin?shop=YOUR_STORE.myshopify.com`);
  console.log(`   Swipe:     ${APP_URL}/swipe?shop=YOUR_STORE.myshopify.com`);
  console.log(`   Install:   ${APP_URL}/auth?shop=YOUR_STORE.myshopify.com\n`);
});
