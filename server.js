import http from 'node:http';

const PORT          = process.env.PORT           || 3001;
const CLIENT_ID     = process.env.PA_ACCESS_KEY  ?? '';
const CLIENT_SECRET = process.env.PA_SECRET_KEY  ?? '';
const PARTNER_TAG   = process.env.PA_PARTNER_TAG ?? 'sursho-20';
const AL_AFFILIATE  = process.env.AL_AFFILIATE_ID ?? '';
const AL_WEBSITE    = process.env.AL_WEBSITE_ID   ?? '';
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;
const TOKEN_URL     = 'https://api.amazon.com/auth/o2/token';
const CA_BASE       = 'https://creatorsapi.amazon';
const AL_BASE       = 'https://classic.avantlink.com/api.php';
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

function caHeaders(token) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE };
}

const CA_RESOURCES = [
  'images.primary.large', 'images.variants.large',
  'itemInfo.title', 'itemInfo.features', 'itemInfo.byLineInfo',
  'offersV2.listings.price', 'offersV2.listings.availability',
];

const SECTION_QUERIES = {
  hottest:     { keywords: 'surf',                sortBy: 'Relevance'          },
  collage:     { keywords: 'surfboard wetsuit',   sortBy: 'Relevance'          },
  bestofweek:  { keywords: 'surfboard',           sortBy: 'AvgCustomerReviews' },
  favorites:   { keywords: 'wetsuit',             sortBy: 'AvgCustomerReviews' },
  deals:       { keywords: 'surf sale',           sortBy: 'Price:LowToHigh'    },
  clearance:   { keywords: 'surf clearance',      sortBy: 'Price:LowToHigh'    },
  toppicks:    { keywords: 'surf accessories',    sortBy: 'AvgCustomerReviews' },
  bestselling: { keywords: 'surf apparel',        sortBy: 'AvgCustomerReviews' },
  savings:     { keywords: 'surf discount',       sortBy: 'Price:LowToHigh'    },
};

const CATEGORY_KEYWORDS = {
  wetsuits: 'wetsuit', 'surf-apparel': 'boardshorts apparel',
  surfboards: 'surfboard', 'surf-accessories': 'leash fins wax',
  'surf-footwear': 'sandals water shoes', 'surf-gear': 'hat sunglasses watch',
  'womens-surfwear': 'womens swimwear bikini rash guard', sale: 'sale clearance',
  trending: 'surf', bestsellers: 'surfboard', new: 'surf', all: 'surf',
  brands: 'surf', hurley: 'hurley', billabong: 'billabong',
  quiksilver: 'quiksilver', oneill: 'oneill', 'rip-curl': 'rip curl',
  roxy: 'roxy', volcom: 'volcom', rvca: 'rvca', vissla: 'vissla',
};

async function caSearch(keywords, opts = {}) {
  const token = await getToken();
  const payload = {
    partnerTag: PARTNER_TAG, keywords, marketplace: MARKETPLACE,
    searchIndex: 'SportsAndOutdoors',
    itemCount: Math.min(opts.itemCount ?? 10, 10),
    sortBy: opts.sortBy ?? 'Relevance',
    resources: CA_RESOURCES,
  };
  const res = await fetch(`${CA_BASE}/catalog/v1/searchItems`, { method: 'POST', headers: caHeaders(token), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`CA SearchItems ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data?.searchResult?.items ?? [];
}

async function caGetItem(asin) {
  const token = await getToken();
  const payload = { partnerTag: PARTNER_TAG, itemIds: [asin], itemIdType: 'ASIN', marketplace: MARKETPLACE, resources: [...CA_RESOURCES, 'variationSummary'] };
  const res = await fetch(`${CA_BASE}/catalog/v1/getItems`, { method: 'POST', headers: caHeaders(token), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`CA GetItems ${res.status}`);
  const data = await res.json();
  return data?.itemsResult?.items?.[0] ?? null;
}

function mapCaItem(item, sectionTag, categorySlug) {
  const rawImage = item.images?.primary?.large?.url ?? '';
  if (!rawImage) return null;
  const imageUrl = rawImage.replace(/\._[A-Z0-9]+_\.jpg$/, '._AC_SL1500_.jpg');
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
    network: 'amazon',
  };
}

const AL_FIELDS = 'Product+Name|Brand+Name|Retail+Price|Sale+Price|Large+Image|Buy+URL|Abbreviated+Description|Price+Discount+Percent|Merchant+Name|Merchant+Id|Product+Id';

async function alSearch(keywords, opts = {}) {
  const count = Math.min(opts.itemCount ?? 20, 20);
  let url = `${AL_BASE}?module=ProductSearch&affiliate_id=${AL_AFFILIATE}&website_id=${AL_WEBSITE}&search_term=${encodeURIComponent(keywords)}&output=json&search_results_count=${count}&search_results_fields=${AL_FIELDS}`;
  if (opts.merchantId) url += `&merchant_id=${opts.merchantId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AvantLink search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function mapAlItem(item, sectionTag, categorySlug) {
  const rawImage = item['strLargeImage'] ?? item['Large_Image'] ?? '';
  if (!rawImage) return null;
  const imageUrl = rawImage;
  const salePrice = parseFloat(item['dblProductSalePrice'] || item['Sale_Price'] || '0');
  const retailPrice = parseFloat(item['dblProductPrice'] || item['Retail_Price'] || '0');
  const price = salePrice > 0 ? salePrice : retailPrice;
  if (!price) return null;
  const originalPrice = retailPrice > price ? retailPrice : null;
  const discountPct = parseFloat(item['dblProductOnSalePercent'] || item['Price_Discount_Percent'] || '0');
  const discount = Math.round(discountPct);
  const title = item['strProductName'] ?? item['Product_Name'] ?? '';
  const brand = item['strBrandName'] ?? item['Brand_Name'] ?? item['strMerchantName'] ?? item['Merchant_Name'] ?? '';
  const description = item['txtAbbreviatedDescription'] ?? item['Abbreviated_Description'] ?? title;
  const buyUrl = item['strBuyURL'] ?? item['Buy_URL'] ?? '';
  const merchantId = String(item['lngMerchantId'] ?? item['Merchant_Id'] ?? '0').padStart(4, '0');
  const productId = String(item['lngProductId'] ?? item['Product_Id'] ?? Math.random()).replace(/[^A-Z0-9]/gi, '').substring(0, 6).toUpperCase();
  const asin = `AL${merchantId}${productId}`.substring(0, 14);
  const badge = discount >= 30 ? 'sale' : discount > 0 ? 'deal' : '';
  const catLabel = categorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    asin, sectionTag, categorySlug, lastFetched: Date.now(),
    price, title, brand, imageUrl, originalPrice: originalPrice ?? 0,
    rating: 4.0, reviewCount: 0, description, category: catLabel, badge, inStock: true, discount,
    affiliateUrl: buyUrl, network: 'avantlink', merchantName: item['strMerchantName'] ?? item['Merchant_Name'] ?? '',
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
    affiliateUrl: p.affiliateUrl, network: p.network, merchantName: p.merchantName,
  };
}

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return e.data;
}
function setCached(key, data) { cache.set(key, { ts: Date.now(), data }); }

function interleave(a, b) {
  const result = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) result.push(a[i]);
    if (i < b.length) result.push(b[i]);
  }
  return result;
}

async function fetchSection(section, limit) {
  const cached = getCached(`section:${section}`);
  if (cached) return cached.slice(0, limit);
  const query = SECTION_QUERIES[section];
  if (!query) return [];
  const catSlug = (section === 'deals' || section === 'clearance' || section === 'savings') ? 'sale'
    : (section === 'favorites' || section === 'toppicks' || section === 'bestselling') ? 'trending' : 'all';
  const [caResult, alResult] = await Promise.allSettled([
    CLIENT_ID && CLIENT_SECRET ? caSearch(query.keywords, { itemCount: 5, sortBy: query.sortBy }) : Promise.resolve([]),
    AL_AFFILIATE && AL_WEBSITE ? alSearch(query.keywords, { itemCount: 20 }) : Promise.resolve([]),
  ]);
  const caMapped = (caResult.status === 'fulfilled' ? caResult.value : []).map(i => mapCaItem(i, section, catSlug)).filter(Boolean);
  const alMapped = (alResult.status === 'fulfilled' ? alResult.value : []).map(i => mapAlItem(i, section, catSlug)).filter(Boolean);
  const merged = interleave(caMapped, alMapped);
  setCached(`section:${section}`, merged);
  return merged.slice(0, limit);
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
  const [caResult, alResult] = await Promise.allSettled([
    CLIENT_ID && CLIENT_SECRET ? caSearch(keywords, { itemCount: 5, sortBy }) : Promise.resolve([]),
    AL_AFFILIATE && AL_WEBSITE ? alSearch(keywords, { itemCount: 20 }) : Promise.resolve([]),
  ]);
  const caMapped = (caResult.status === 'fulfilled' ? caResult.value : []).map(i => mapCaItem(i, key, slug)).filter(Boolean);
  const alMapped = (alResult.status === 'fulfilled' ? alResult.value : []).map(i => mapAlItem(i, key, slug)).filter(Boolean);
  const merged = interleave(caMapped, alMapped);
  setCached(key, merged);
  return merged.slice(offset, offset + limit);
}

async function fetchSearch(q, limit) {
  const key = `search:${q.toLowerCase().trim()}`;
  const cached = getCached(key);
  if (cached) return cached.slice(0, limit);
  const [caResult, alResult] = await Promise.allSettled([
    CLIENT_ID && CLIENT_SECRET ? caSearch(`${q} surf`, { itemCount: 5 }) : Promise.resolve([]),
    AL_AFFILIATE && AL_WEBSITE ? alSearch(`${q} surf`, { itemCount: 20 }) : Promise.resolve([]),
  ]);
  const caMapped = (caResult.status === 'fulfilled' ? caResult.value : []).map(i => mapCaItem(i, key, 'all')).filter(Boolean);
  const alMapped = (alResult.status === 'fulfilled' ? alResult.value : []).map(i => mapAlItem(i, key, 'all')).filter(Boolean);
  const merged = interleave(caMapped, alMapped);
  setCached(key, merged);
  return merged.slice(0, limit);
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

  if (pathname === '' || pathname === '/') {
    json(res, { ok: true, service: 'SurfOutlook Proxy', amazon: !!(CLIENT_ID && CLIENT_SECRET), avantlink: !!(AL_AFFILIATE && AL_WEBSITE) }, 200, origin);
    return;
  }

  if (pathname === '/api/products' || pathname === '/products') {
    const action   = url.searchParams.get('action');
    const section  = url.searchParams.get('section');
    const category = url.searchParams.get('category');
    const q        = url.searchParams.get('q');
    const sort     = url.searchParams.get('sort') ?? 'featured';
    const page     = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit    = parseInt(url.searchParams.get('limit') ?? '20', 10);

    if (action === 'test') {
      const results = {};
      if (CLIENT_ID && CLIENT_SECRET) {
        try {
          const token = await getToken();
          const payload = { partnerTag: PARTNER_TAG, keywords: 'surfboard', marketplace: MARKETPLACE, itemCount: 1, resources: ['itemInfo.title'] };
          const r = await fetch(`${CA_BASE}/catalog/v1/searchItems`, { method: 'POST', headers: caHeaders(token), body: JSON.stringify(payload) });
          const text = await r.text();
          let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
          results.amazon = { ok: r.ok, status: r.status, response: parsed };
        } catch (err) { results.amazon = { ok: false, error: String(err?.message ?? err) }; }
      } else { results.amazon = { ok: false, error: 'Credentials not set' }; }
      if (AL_AFFILIATE && AL_WEBSITE) {
        try {
          const items = await alSearch('surfboard', { itemCount: 1 });
          const mapped = items.map(i => mapAlItem(i, 'test', 'all')).filter(Boolean);
          results.avantlink = { ok: true, rawCount: items.length, mappedCount: mapped.length, sample: mapped[0] ?? null };
        } catch (err) { results.avantlink = { ok: false, error: String(err?.message ?? err) }; }
      } else { results.avantlink = { ok: false, error: 'AL_AFFILIATE_ID or AL_WEBSITE_ID not set' }; }
      json(res, results, 200, origin);
      return;
    }

    if (action === 'merchants') {
      try {
        const items = await alSearch('surf', { itemCount: 20 });
        const seen = new Map();
        items.forEach(i => {
          const id = i['lngMerchantId'] ?? i['Merchant_Id'] ?? '?';
          const name = i['strMerchantName'] ?? i['Merchant_Name'] ?? '?';
          if (!seen.has(id)) seen.set(id, name);
        });
        json(res, { ok: true, totalResults: items.length, merchants: [...seen.entries()].map(([id, name]) => ({ id, name })) }, 200, origin);
      } catch (err) { json(res, { ok: false, error: String(err?.message ?? err) }, 500, origin); }
      return;
    }

    try {
      if (q) json(res, { products: (await fetchSearch(q, limit)).map(toProduct), source: 'live' }, 200, origin);
      else if (category) json(res, { products: (await fetchCategory(category, sort, page, limit)).map(toProduct), source: 'live' }, 200, origin);
      else if (section) json(res, { products: (await fetchSection(section, limit)).map(toProduct), source: 'live' }, 200, origin);
      else json(res, { products: [], source: 'empty' }, 200, origin);
    } catch (err) {
      console.error('products error:', err?.message ?? err);
      json(res, { products: [], error: String(err?.message ?? err) }, 500, origin);
    }
    return;
  }

  const asinMatch = pathname.match(/^(?:\/api)?\/products\/([A-Z0-9]{10})$/);
  if (asinMatch) {
    if (!CLIENT_ID || !CLIENT_SECRET) { json(res, { error: 'Amazon credentials not configured.' }, 500, origin); return; }
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
        network: 'amazon',
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
  console.log(`Amazon: ${CLIENT_ID ? 'configured' : 'NOT SET'} | AvantLink: ${AL_AFFILIATE ? 'configured' : 'NOT SET'}`);
});
