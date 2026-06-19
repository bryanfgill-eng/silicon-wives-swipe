# Silicon Wives — Swipe App

Tinder-style product discovery app for Silicon Wives Shopify store.

## Quick Deploy (Railway — Free)

### Step 1 — Create Shopify App

1. Go to [partners.shopify.com](https://partners.shopify.com) → Apps → Create App → Custom App
2. App name: **Silicon Wives Swipe**
3. App URL: `https://your-app.railway.app` (fill in after Step 2)
4. Redirect URL: `https://your-app.railway.app/auth/callback`
5. Note down your **API Key** and **API Secret**

### Step 2 — Deploy to Railway

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Push this repo to GitHub first, or use Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. In Railway dashboard → Variables, add:
   ```
   SHOPIFY_API_KEY=your_api_key
   SHOPIFY_API_SECRET=your_api_secret
   APP_URL=https://your-app.railway.app
   ```
4. Copy your Railway URL (e.g. `https://silicon-wives.railway.app`)

### Step 3 — Update Shopify App URLs

Back in Shopify Partners → your app:
- App URL: `https://your-app.railway.app`
- Redirect URLs: `https://your-app.railway.app/auth/callback`

### Step 4 — Install on your store

Visit: `https://your-app.railway.app/auth?shop=silicon-wife.myshopify.com`

This will trigger the OAuth flow and install the app on your store.

### Step 5 — Add swipe page to your store

1. After installing, visit the admin: `https://your-app.railway.app/admin?shop=silicon-wife.myshopify.com`
2. Click **Sync Products** (fetches all products from Shopify)
3. Copy your swipe URL: `https://your-app.railway.app/swipe?shop=silicon-wife.myshopify.com`
4. In Shopify Admin → Online Store → Pages → Add page
5. Title: **Find Your Match**
6. Switch to HTML editor, paste:
   ```html
   <iframe src="https://your-app.railway.app/swipe?shop=silicon-wife.myshopify.com"
     style="width:100%;height:100vh;border:none;display:block;"
     allow="autoplay">
   </iframe>
   ```
7. Save

## Admin Panel

Access at: `https://your-app.railway.app/admin?shop=silicon-wife.myshopify.com`

Features:
- **Sync Products** — fetches latest products from Shopify (cached 1 hour)
- **Pin** — lock a product to a specific swipe position
- **Boost** — float a product up in AI ranking (2× score)
- **Suppress** — sink a product to the bottom
- **Filters** — exclude types, price range
- **Sort modes** — Smart, Price, Title

## Architecture

```
/src/index.js          — Express server (OAuth, admin API, swipe page)
/public/admin.html     — Admin UI (served at /admin)
/public/swipe-template.html  — Swipe app HTML template
/data/                 — Per-store config + token files (gitignored)
```

## Local Development

```bash
# Install
npm install

# Copy env
cp .env.example .env
# Fill in SHOPIFY_API_KEY, SHOPIFY_API_SECRET
# Set APP_URL to your ngrok URL

# Run ngrok for public URL (required for OAuth)
ngrok http 3002

# Start
npm run dev
```
