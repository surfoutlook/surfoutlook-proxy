import http from 'node:http';
import { createHmac, createHash } from 'node:crypto';

const PORT = process.env.PORT || 3001;
const PA_ACCESS_KEY  = process.env.PA_ACCESS_KEY  ?? '';
const PA_SECRET_KEY  = process.env.PA_SECRET_KEY  ?? '';
const PA_PARTNER_TAG = process.env.PA_PARTNER_TAG ?? 'sursho-20';
const PA_HOST        = 'webservices.amazon.com';
const PA_REGION      = 'us-east-1';
const PA_SERVICE     = 'ProductAdvertisingAPI';
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000;

const cache = new Map();

const SECTION_QUERIES = {
  hottest:     { keywords: 'surfing gear',         sortBy: 'Relevance',          itemCount: 10 },
  collage:     { keywords: 'surf lifestyle',        sortBy: 'Relevance',          itemCount: 10 },
  bestofweek:  { keywords: 'surf board wetsuit',    sortBy: 'AvgCustomerReviews', itemCount: 10 },
  favorites:   { keywords: 'popular surf gear',     sortBy: 'AvgCustomerReviews', itemCount: 10 },
  deals:       { keywords: 'surf sale',             sortBy: 'Price:LowToHigh',    itemCount: 10 },
  clearance:   { keywords: 'surf clearance',        sortBy: 'Price:LowToHigh',    itemCount: 10 },
  toppicks:    { keywords: 'top surf gear',         sortBy: 'AvgCustomerReviews', itemCount: 10 },
  bestselling: { keywords: 'best selling surf',     sortBy: 'AvgCustomerReviews', itemCount: 10 },
  savings:     { keywords: 'surf discount',         sortBy: 'Price:LowToHigh',    itemCount: 10 },
};

const CATEGORY_KEYWORDS = {
  wetsuits:           'surf wetsuit neoprene',
  'surf-apparel':     'surfing boardshorts apparel',
  surfboards:         'surfboard',
  'surf-accessories': 'surf accessories leash wax',
  'surf-footwear':    'surf sandals water shoes',
  'surf-gear':        'surf hat sunglasses waterproof watch',
  'womens-surfwear':  'women surf swimwear rash guard bikini',
  sale:               'surf sale clearance discount',
  trending:           'surf trending',
  bestsellers:        'surf bestseller',
  new:                'new surf gear',
  all:                'surfing',
  brands:             'surf brand billabong quiksilver ripcurl',
  hurley:             'hurley surf',
  billabong:          'billabong surf',
  quiksilver:         'quiksilver surf',
  oneill:             'oneill wetsuit surf',
  'rip-curl':         'rip curl wetsuit surf',
  roxy:               'roxy women surf',
  volcom:             'volcom surf',
  rvca:               'rvca surf',
  vissla:             'vissla surf wetsuit',
};

const PA_RESOURCES = [
  'ItemInfo.Title', 'ItemInfo.Features', 'ItemInfo.ByLineInfo',
  'Images.Primary.Large', 'Images.Variants.Large',
  'Offers.Listings.Price', 'Offers.Listings.SavingBasis', 'Offers.Listings.Availability.Type',
  'CustomerReviews.StarRating', 'CustomerReviews.Count',
  'BrowseNodeInfo.BrowseNodes',
];

const PA_RESOURCES_DETAIL = [
  ...PA_RESOURCES,
  'VariationSummary.VariationDimension',
  'VariationSummary.Price.HighestPrice',
];

function sha256Hex(msg) {
  return createHash('sha256').update(msg, 'utf8').digest('hex');
}
function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}
function getAmzDate() {
  return new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}
function buildAuthHeaders(operation, bodyStr) {
  const amzDate   = getAmzDate();
  const dateStamp = amzDate.substring(0, 8);
  const target    = `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`;
  const uri       = `/paapi5/${operation.toLowerCase()}`;
  const bodyHash  = sha256Hex(bodyStr);
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${PA_HOST}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
  const canonicalReq  = ['POST', uri, '', canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const credScope     = `${dateStamp}/${PA_REGION}/${PA_SERVICE}/aws4_request`;
  const stringToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256Hex(canonicalReq)].join('\n');
  const kDate    = hmacSha256(`AWS4${PA_SECRET_KEY}`, dateStamp);
  const kRegion  = hmacSha256(kDate, PA_REGION);
  const kService = hmacSha256(kRegion, PA_SERVICE);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const sig      = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    'Content-Encoding': 'amz-1.0',
    'Content-Type': 'application/json; charset=utf-8',
    'Host': PA_HOST,
    'X-Amz-Date': amzDate,
    'X-Amz-Target': target,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${PA_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

async function paSearch(keywords, opts = {}) {
  const payload = {
    PartnerTag: PA_PARTNER_TAG, PartnerType: 'Associates',
    Keywords: keywords, SearchIndex: 'SportsAndOutdoors',
    ItemCount: Math.min(opts.itemCount ?? 10, 10),
    SortBy: opts.sortBy ?? 'Relevance',
    Resources: PA_RESOURCES, Marketplace: 'www.amazon.com',
  };
  const body    = JSON.stringify(payload);
  const headers = buildAuthHeaders('SearchItems', body);
  const res     = await fetch(`https://${PA_HOST}/paapi5/searchitems`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`PA API SearchItems ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data?.SearchResult?.Items ?? [];
}

async function paGetItem(asin) {
  const payload = {
    PartnerTag: PA_PARTNER_TAG, PartnerType: 'Associates',
    ItemIds: [asin], Resources: PA_RESOURCES_DETAIL, Marketplace: 'www.amazon.com',
  };
  const body    = JSON.stringify(payload);
  const headers = buildAuthHeaders('GetItems', body);
  const res     = await fetch(`https://${PA_HOST}/paapi5/getitems`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`PA API GetItems ${res.status}`);
  const data = await res.json();
  return data?.ItemsResult?.Items?.[0] ?? null;
}

function mapItem(item, sectionTag, categorySlug) {
  const imageUrl = item.Images?.Primary?.Large?.URL ?? '';
  if (!imageUrl) return null;
  const listing = item.Offers?.Listings?.[0];
  const price   = listing?.Price?.Amount ?? 0;
  if (!price) return null;
  const savingBasis   = listing?.SavingBasis?.Amount;
  const originalPrice = savingBasis && savingBasis > price ? savingBasis : null;
  const discount      = originalPrice ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;
  const title         = item.ItemInfo?.Title?.DisplayValue ?? '';
  const brand         = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ?? item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue ?? '';
  const features      = item.ItemInfo?.Features?.DisplayValues ?? [];
  const description   = features.slice(0, 2).join('. ') || title;
  const rating        = item.CustomerReviews?.StarRating?.Value ?? 4.2;
  const reviewCount   = item.CustomerReviews?.Count ?? 0;
  const inStock       = listing?.Availability?.Type !== 'OutOfStock';
  const badge         = discount >= 30 ? 'sale' : discount > 0 ? 'deal' : reviewCount > 2000 ? 'bestseller' : '';
  const catLabel      = categorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    asin: item.ASIN, sectionTag, categorySlug, lastFetched: Date.now(),
    price, title, brand, imageUrl, originalPrice: originalPrice ?? 0,
    rating, reviewCount, description, category: catLabel, badge, inStock, discount,
    affiliateUrl: `https://www.amazon.com/dp/${item.ASIN}?tag=${PA_PARTNER_TAG}`,
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
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) { cache.set(key, { ts: Date.now(), data }); }

async function fetchSection(section, limit) {
  const key = `section:${section}`;
  const cached = getCached(key);
  if (cached) return cached.slice(0, limit);
  const query = SECTION_QUERIES[section];
  if (!query) return [];
  const items = await paSearch(query.keywords, { itemCount: Math.min(query.itemCount, limit + 2), sortBy: query.sortBy });
  const catSlug = (section === 'deals' || section === 'clearance' || section === 'savings') ? 'sale'
    : (section === 'favorites' || section === 'toppicks' || section === 'bestselling') ? 'trending' : 'all';
  const mapped = items.map(i => mapItem(i, section, catSlug)).filter(Boolean);
  setCached(key, mapped);
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
  const items  = await paSearch(keywords, { itemCount: 10, sortBy });
  const mapped = items.map(i => mapItem(i, key, slug)).filter(Boolean);
  setCached(key, mapped);
  return mapped.slice(offset, offset + limit);
}

async function fetchSearch(q, limit) {
  const key = `search:${q.toLowerCase().trim()}`;
  const cached = getCached(key);
  if (cached) return cached.slice(0, limit);
  const items  = await paSearch(`${q} surf`, { itemCount: Math.min(limit, 10), sortBy: 'Relevance' });
  const mapped = items.map(i => mapItem(i, key, 'all')).filter(Boolean);
  setCached(key, mapped);
  return mapped.slice(0, limit);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(res, data, status = 200, origin) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(origin)); res.end(); return; }
  if (req.method !== 'GET') { json(res, { error: 'Method not allowed' }, 405, origin); return; }

  const url      = new URL(req.url, `http://localhost`);
  const pathname = url.pathname.replace(/\/+$/, '');

  if (pathname === '' || pathname === '/') {
    json(res, { ok: true, service: 'SurfOutlook PA API Proxy' }, 200, origin); return;
  }

  if (pathname === '/api/products' || pathname === '/products') {
    if (!PA_ACCESS_KEY || !PA_SECRET_KEY) {
      json(res, { ok: false, error: 'PA_ACCESS_KEY and PA_SECRET_KEY not set.' }, 500, origin); return;
    }
    const action   = url.searchParams.get('action');
    const section  = url.searchParams.get('section');
    const category = url.searchParams.get('category');
    const q        = url.searchParams.get('q');
    const sort     = url.searchParams.get('sort') ?? 'featured';
    const page     = parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit    = parseInt(url.searchParams.get('limit') ?? '20', 10);

    if (action === 'test') {
      const payload = {
        PartnerTag: PA_PARTNER_TAG, PartnerType: 'Associates',
        Keywords: 'surfboard', SearchIndex: 'SportsAndOutdoors', ItemCount: 1,
        SortBy: 'Relevance', Resources: ['ItemInfo.Title', 'Images.Primary.Large', 'Offers.Listings.Price'],
        Marketplace: 'www.amazon.com',
      };
      const body = JSON.stringify(payload);
      const headers = buildAuthHeaders('SearchItems', body);
      try {
        const r = await fetch(`https://${PA_HOST}/paapi5/searchitems`, { method: 'POST', headers, body });
        const text = await r.text();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
        json(res, { ok: r.ok, status: r.status, partnerTag: PA_PARTNER_TAG, accessKeyPrefix: PA_ACCESS_KEY.substring(0, 6) + '...', response: parsed }, 200, origin);
      } catch (err) { json(res, { ok: false, error: String(err?.message ?? err) }, 500, origin); }
      return;
    }

    try {
      if (q) {
        json(res, { products: (await fetchSearch(q, limit)).map(toProduct), source: 'amazon' }, 200, origin);
      } else if (category) {
        json(res, { products: (await fetchCategory(category, sort, page, limit)).map(toProduct), source: 'amazon' }, 200, origin);
      } else if (section) {
        json(res, { products: (await fetchSection(section, limit)).map(toProduct), source: 'amazon' }, 200, origin);
      } else {
        json(res, { products: [], source: 'empty' }, 200, origin);
      }
    } catch (err) {
      console.error('products error:', err?.message ?? err);
      json(res, { products: [], error: String(err?.message ?? err) }, 500, origin);
    }
    return;
  }

  const asinMatch = pathname.match(/^(?:\/api)?\/products\/([A-Z0-9]{10})$/);
  if (asinMatch) {
    if (!PA_ACCESS_KEY || !PA_SECRET_KEY) { json(res, { error: 'Credentials not configured.' }, 500, origin); return; }
    const asin = asinMatch[1];
    try {
      const item = await paGetItem(asin);
      if (!item) { json(res, { error: 'Product not found' }, 404, origin); return; }
      const images = [];
      if (item.Images?.Primary?.Large?.URL) images.push(item.Images.Primary.Large.URL);
      (item.Images?.Variants ?? []).forEach(v => { if (v.Large?.URL && !images.includes(v.Large.URL)) images.push(v.Large.URL); });
      const listing = item.Offers?.Listings?.[0];
      const price   = listing?.Price?.Amount ?? 0;
      const savingBasis   = listing?.SavingBasis?.Amount;
      const originalPrice = savingBasis && savingBasis > price ? savingBasis : null;
      const product = {
        asin: item.ASIN,
        title: item.ItemInfo?.Title?.DisplayValue ?? '',
        brand: item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ?? item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue ?? '',
        price, originalPrice: originalPrice ?? undefined,
        imageUrl: images[0] ?? '', images, category: '', categorySlug: 'all',
        rating: item.CustomerReviews?.StarRating?.Value ?? 4.2,
        reviewCount: item.CustomerReviews?.Count ?? 0,
        description: (item.ItemInfo?.Features?.DisplayValues ?? []).slice(0, 3).join('. '),
        inStock: listing?.Availability?.Type !== 'OutOfStock',
        discount: originalPrice ? Math.round(((originalPrice - price) / originalPrice) * 100) : undefined,
        affiliateUrl: `https://www.amazon.com/dp/${item.ASIN}?tag=${PA_PARTNER_TAG}`,
      };
      const dims = item.VariationSummary?.VariationDimension ?? [];
      const variants = dims.reduce((acc, d) => ({ ...acc, [d]: [] }), {});
      json(res, { product, variants, images }, 200, origin);
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
  if (!PA_ACCESS_KEY || !PA_SECRET_KEY) console.warn('WARNING: PA_ACCESS_KEY or PA_SECRET_KEY is not set.');
});
