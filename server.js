import http from 'node:http';

const PORT          = process.env.PORT           || 3001;
const CLIENT_ID     = process.env.PA_ACCESS_KEY  ?? '';
const CLIENT_SECRET = process.env.PA_SECRET_KEY  ?? '';
const PARTNER_TAG   = process.env.PA_PARTNER_TAG ?? 'sursho-20';
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;
const TOKEN_URL     = 'https://api.amazon.com/auth/o2/token';
const API_BASE      = 'https://creatorsapi.amazon';
const MARKETPLACE   = 'www.amazon.com';

let tokenCache = { token: null, expiresAt: 0 };
const cache = new Map();

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: 'creatorsapi::default' }),
  });
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

function apiHeaders(token) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE };
}

const RESOURCES = [
  'images.primary.large', 'images.variants.large',
  'itemInfo.title', 'itemInfo.features', 'itemInfo.byLineInfo',
  'offersV2.listings.price', 'offersV2.listings.availability',
];

const SECTION_QUERIES = {
  hottest:     { keywords: 'surfing gear',       sortBy: 'Relevance'          },
  collage:     { keywords: 'surf lifestyle',      sortBy: 'Relevance'          },
  bestofweek:  { keywords: 'surf board wetsuit',  sortBy: 'AvgCustomerReviews' },
  favorites:   { keywords: 'popular surf gear',   sortBy: 'AvgCustomerReviews' },
  deals:       { keywords: 'surf sale',           sortBy: 'Price:LowToHigh'    },
  clearance:   { keywords: 'surf clearance',      sortBy: 'Price:LowToHigh'    },
  toppicks:    { keywords: 'top surf gear',       sortBy: 'AvgCustomerReviews' },
  bestselling: { keywords: 'best selling surf',   sortBy: 'AvgCustomerReviews' },
  savings:     { keywords: 'surf discount',       sortBy: 'Price:LowToHigh'    },
};

const CATEGORY_KEYWORDS = {
  wetsuits: 'surf wetsuit neoprene', 'surf-apparel': 'surfing boardshorts apparel',
  surfboards: 'surfboard', 'surf-accessories': 'surf accessories leash wax',
  'surf-footwear': 'surf sandals water shoes', 'surf-gear': 'surf hat sunglasses waterproof watch',
  'womens-surfwear': 'women surf swimwear rash guard bikini', sale: 'surf sale clearance discount',
  trending: 'surf trending', bestsellers: 'surf bestseller', new: 'new surf gear', all: 'surfing',
  brands: 'surf brand billabong quiksilver ripcurl', hurley: 'hurley surf', billabong: 'billabong surf',
  quiksilver: 'quiksilver surf', oneill: 'oneill wetsuit surf', 'rip-curl': 'rip curl wetsuit surf',
  roxy: 'roxy women surf', volcom: 'volcom surf', rvca: 'rvca surf', vissla: 'vissla surf wetsuit',
};

async function caSearch(keywords, opts = {}) {
  const token = await getToken();
  const payload = {
    partnerTag: PARTNER_TAG, keywords, marketplace: MARKETPLACE,
    searchIndex: 'SportsAndOutdoors',
    itemCount: Math.min(opts.itemCount ?? 10, 10),
    sortBy: opts.sortBy ?? 'Relevance',
    resources: RESOURCES,
  };
  const res = await fetch(`${API_BASE}/catalog/v1/searchItems`, { method: 'POST', headers: apiHeaders(token), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`SearchItems ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data?.searchResult?.items ?? [];
}

async function caGetItem(asin) {
  const token = await getToken();
  const payload = {
    partnerTag: PARTNER_TAG, itemIds: [asin], itemIdType: 'ASIN', marketplace: MARKETPLACE,
    resources: [...RESOURCES, 'variationSummary'],
  };
  const res = await fetch(`${API_BASE}/catalog/v1/getItems`, { method: 'POST', headers: apiHeaders(token), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`GetItems ${res.status}`);
  const data = await res.json();
  return data?.itemsResult?.items?.[0] ?? null;
}

function mapItem(item, sectionTag, categorySlug) {
  const imageUrl = item.images?.primary?.large?.url ?? '';
  if (!imageUrl) return null;
  const listing = item.offersV2?.listings?.[0];
  const price = listing?.price?.money?.amount ?? 0;
  if (!price) return null;
  const savingBasis = listing?.price?.savingBasis?.money?.amount;
  const originalPrice = savingBasis && savingBasis > price ? savingBasis : null;
  const discount = originalPrice ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;
  const title = item.itemInfo?.title?.displayValue ?? '';
  const brand = item.itemInfo?.byLineInfo?.brand?.displayValue ?? item.itemInfo?.byLineInfo?.manufacturer?.displayValue ?? '';
  const features = item.itemInfo?.features?.displayValues ?? [];
  const description = features.slice(0, 2).join('. ') || title;
  const inStock = listing?.availability?.type === 'IN_STOCK';
  const badge = discount >= 30 ? 'sale' : discount > 0 ? 'deal' : '';
  const catLabel = categorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    asin: item.asin, sectionTag, categorySlug, lastFetched: Date.now(),
    price, title, brand, imageUrl, originalPrice: originalPrice ?? 0,
    rating: 4.2, reviewCount: 0, description, category: catLabel, badge, inStock, discount,
    affiliateUrl: item.detailPageURL ?? `https://www.amazon.com/dp/${item.asin}?tag=${PARTNER_TAG}`,
  };
}

function toProduct(p) {
  return {
    asin: p.asin, title: p.title, brand: p.brand, price: p.price,
    originalPrice: p.originalPrice > 0 ? p.originalPrice : undefined,
    imageUrl: p.imageUrl, category: p.category, categorySlug: p.categorySlug,
    subcategory: p.category, rating: p.rating, reviewCount: p.reviewCount,
    description: p.description, badge: p.badge || undefined, inStock: p.inStock,
    discount: p.originalPrice > 0 ? Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100) : undefined,
    affiliateUrl: p.affiliateUrl,
  };
}

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return e.data;
}
function setCached(key, data) { cache.set(key, { ts: Date.now(), data }); }

async function fetchSection(section, limit) {
  const cached = getCached(`section:${section}`);
  if (cached) return cached.slice(0, limit);
  const query = SECTION_QUERIES[section];
  if (!query) return [];
  const items = await caSearch(query.keywords, { itemCount: Math.min(10, limit + 2), sortBy: query.sortBy });
  const catSlug = (section === 'deals' || section === 'clearance' || section === 'savings') ? 'sale'
    : (section === 'favorites' || section === 'toppicks' || section === 'bestselling') ? 'trending' : 'all';
  const mapped = items.map(i => mapItem(i, section, catSlug)).filter(Boolean);
  setCached(`section:${section}`, mapped);
  return mapped.slice(0, limit);
}

async function fetchCategory(slug, sort, page, limit) {
  const key = `cat:${slug}:${sort}`;
  const cached = getCached(key);
  const offset = (page - 1) * limit;
  if (cached) return cached.slice(offset, offset + limit);
  const keywords = CATEGORY_KEYWORDS[slug] ?? `${slug.replace(/-/g, ' ')} surf`;
  const sortBy = sort === 'price_asc' ? 'Price:LowToHigh' : sort === 'price_desc' ? 'Price:HighToLow'
    : sort === 'rating' || sort === 'bestseller' ? 'AvgCustomerReviews'
    : sort === 'newest' ? 'NewestArrivals' : 'Relevance';
  const items = await caSearch(keywords, { itemCount: 10, sortBy });
  const mapped = items.map(i => mapItem(i, key, slug)).filter(Boolean);
  setCached(key, mapped);
  return mapped.slice(offset, offset + limit);
}

async function fetchSearch(q, limit) {
  const key = `search:${q.toLowerCase().trim()}`;
  const cached = getCached(key);
  if (cached) return cached.slice(0, limit);
  const items = await caSearch(`${q} surf`, { itemCount: Math.min(limit, 10) });
  const mapped = items.map(i => mapItem(i, key, 'all')).filter(Boolean);
  setCached(key, mapped);
  return mapped.slice(0, limit);
}

function corsHeaders(origin) {
  return { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
}
function json(res, data, status = 200, origin) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(origin)); res.end(); return; }
  if (req.method !== 'GET') { json(res, { error: 'Method not allowed' }, 405, origin); return; }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '');

  if (pathname === '' || pathname === '/') { json(res, { ok: true, service: 'SurfOutlook Creators API Proxy' }, 200, origin); return; }

  if (pathname === '/api/products' || pathname === '/products') {
    if (!CLIENT_ID || !CLIENT_SECRET) { json(res, { ok: false, error: 'PA_ACCESS_KEY and PA_SECRET_KEY not set.' }, 500, origin); return; }
    const action = url.searchParams.get('action');
    const section = url.searchParams.get('section');
    const category = url.searchParams.get('category');
    const q = url.searchParams.get('q');
    const sort = url.searchParams.get('sort') ?? 'featured';
    const page = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);

    if (action === 'test') {
      try {
        const token = await getToken();
        const payload = { partnerTag: PARTNER_TAG, keywords: 'surfboard', marketplace: MARKETPLACE, itemCount: 1, resources: ['itemInfo.title', 'images.primary.large', 'offersV2.listings.price'] };
        const r = await fetch(`${API_BASE}/catalog/v1/searchItems`, { method: 'POST', headers: apiHeaders(token), body: JSON.stringify(payload) });
        const text = await r.text();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
        json(res, { ok: r.ok, status: r.status, partnerTag: PARTNER_TAG, clientIdPrefix: CLIENT_ID.substring(0, 10) + '...', response: parsed }, 200, origin);
      } catch (err) { json(res, { ok: false, error: String(err?.message ?? err) }, 500, origin); }
      return;
    }

    try {
      if (q) json(res, { products: (await fetchSearch(q, limit)).map(toProduct), source: 'amazon' }, 200, origin);
      else if (category) json(res, { products: (await fetchCategory(category, sort, page, limit)).map(toProduct), source: 'amazon' }, 200, origin);
      else if (section) json(res, { products: (await fetchSection(section, limit)).map(toProduct), source: 'amazon' }, 200, origin);
      else json(res, { products: [], source: 'empty' }, 200, origin);
    } catch (err) {
      console.error('products error:', err?.message ?? err);
      json(res, { products: [], error: String(err?.message ?? err) }, 500, origin);
    }
    return;
  }

  const asinMatch = pathname.match(/^(?:\/api)?\/products\/([A-Z0-9]{10})$/);
  if (asinMatch) {
    if (!CLIENT_ID || !CLIENT_SECRET) { json(res, { error: 'Credentials not configured.' }, 500, origin); return; }
    try {
      const item = await caGetItem(asinMatch[1]);
      if (!item) { json(res, { error: 'Product not found' }, 404, origin); return; }
      const images = [];
      if (item.images?.primary?.large?.url) images.push(item.images.primary.large.url);
      (item.images?.variants ?? []).forEach(v => { if (v.large?.url && !images.includes(v.large.url)) images.push(v.large.url); });
      const listing = item.offersV2?.listings?.[0];
      const price = listing?.price?.money?.amount ?? 0;
      const savingBasis = listing?.price?.savingBasis?.money?.amount;
      const originalPrice = savingBasis && savingBasis > price ? savingBasis : null;
      const product = {
        asin: item.asin, title: item.itemInfo?.title?.displayValue ?? '',
        brand: item.itemInfo?.byLineInfo?.brand?.displayValue ?? item.itemInfo?.byLineInfo?.manufacturer?.displayValue ?? '',
        price, originalPrice: originalPrice ?? undefined, imageUrl: images[0] ?? '', images,
        category: '', categorySlug: 'all', rating: 4.2, reviewCount: 0,
        description: (item.itemInfo?.features?.displayValues ?? []).slice(0, 3).join('. '),
        inStock: listing?.availability?.type === 'IN_STOCK',
        discount: originalPrice ? Math.round(((originalPrice - price) / originalPrice) * 100) : undefined,
        affiliateUrl: item.detailPageURL ?? `https://www.amazon.com/dp/${item.asin}?tag=${PARTNER_TAG}`,
      };
      json(res, { product, variants: {}, images }, 200, origin);
    } catch (err) {
      console.error('product detail error:', err?.message ?? err);
      json(res, { error: String(err?.message ?? err) }, 500, origin);
    }
    return;
  }

  json(res, { error: 'Not found' }, 404, origin);
});

server.listen(PORT, () => {
  console.log(`SurfOutlook proxy running on port ${PORT}`);
  if (!CLIENT_ID || !CLIENT_SECRET) console.warn('WARNING: PA_ACCESS_KEY or PA_SECRET_KEY not set.');
});
