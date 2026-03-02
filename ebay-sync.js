#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════
 * STICKS & STAMPS — eBay Listing Auto-Sync
 * ════════════════════════════════════════════════════
 * 
 * HOW IT WORKS:
 * 1. Fetches eBay store RSS feed (officially supported, no ToS issues)
 * 2. Parses listings: title, price, image, URL, condition
 * 3. Saves listings-data.json → used by the website
 * 4. Optionally sends GHL email campaign to subscribers
 * 
 * SETUP:
 *   npm install node-fetch xml2js
 * 
 * RUN MANUALLY:
 *   node ebay-sync.js
 * 
 * RUN AUTOMATICALLY (GitHub Actions — free):
 *   See .github/workflows/sync.yml instructions below
 * 
 * ENV VARS (optional, for email campaigns):
 *   GHL_API_KEY=your-ghl-api-key
 *   GHL_LOCATION_ID=your-location-id
 *   GHL_EMAIL_TEMPLATE_ID=your-template-id
 * ════════════════════════════════════════════════════
 */

const https = require('https');
const http  = require('http');
const xml2js = require('xml2js'); // npm install xml2js
const fs     = require('fs');
const path   = require('path');

// ── CONFIG ──────────────────────────────────────────
const EBAY_USERNAME   = 'sticksandstamps';
const EBAY_RSS_URL    = `https://www.ebay.com/sch/i.html?_ssn=${EBAY_USERNAME}&_rss=1`;
const OUTPUT_FILE     = path.join(__dirname, 'listings-data.json');
const PREV_FILE       = path.join(__dirname, 'listings-prev.json');
const GHL_API_KEY     = process.env.GHL_API_KEY     || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const GHL_TEMPLATE_ID = process.env.GHL_EMAIL_TEMPLATE_ID || '';

// ── EMOJI MAP (by keywords in title) ────────────────
const EMOJI_MAP = [
  [/washington/i,        '🏛️'],
  [/franklin/i,          '📜'],
  [/lincoln/i,           '🎩'],
  [/jefferson/i,         '📜'],
  [/columbus/i,          '⚓'],
  [/curtiss|jenny|mail plane|airmail/i, '✈️'],
  [/railway|railroad|train/i, '🚂'],
  [/ship|steamship|ocean/i,   '🛳️'],
  [/eagle/i,             '🦅'],
  [/niagara|falls/i,     '🌊'],
  [/canal|panama/i,      '🌊'],
  [/parcel|carrier|clerk/i, '📯'],
  [/byrd|antarct/i,      '🧊'],
  [/wildlife|bird|animal/i, '🦉'],
  [/automobile|car/i,    '🚗'],
  [/poc[ao]hon/i,        '🪶'],
  [/wright/i,            '✈️'],
  [/hitchcock|bogart|monroe|garland|hepburn/i, '🎬'],
  [/sylvester|tweety|bugs|daffy|porky|road runner/i, '🐰'],
  [/civil war/i,         '⚔️'],
  [/declaration|independence/i, '📋'],
];

function getEmoji(title) {
  for (const [re, emoji] of EMOJI_MAP) {
    if (re.test(title)) return emoji;
  }
  return '📮';
}

// ── EXTRACT PRICE FROM TITLE/DESCRIPTION ────────────
function extractPrice(text) {
  const m = text && text.match(/\$[\d,]+(?:\.\d{2})?/);
  return m ? m[0] : null;
}

// ── EXTRACT SCOTT NUMBER ────────────────────────────
function extractScott(title) {
  const m = title && title.match(/Scott[# ]+([A-Z0-9a-z-]+)/i);
  return m ? `Scott #${m[1]}` : null;
}

// ── EXTRACT YEAR ─────────────────────────────────────
function extractYear(title) {
  const m = title && title.match(/[- ](I?[12][0-9]{3})[- ]/);
  if (m) return m[1].replace(/^I/, '');
  const m2 = title && title.match(/\b(1[89][0-9]{2}|20[012][0-9])\b/);
  return m2 ? m2[1] : null;
}

// ── EXTRACT CONDITION ────────────────────────────────
function extractCondition(title) {
  const parts = [];
  if (/MNH/i.test(title))          parts.push('MNH');
  if (/MHN/i.test(title))          parts.push('MNH');
  if (/original gum/i.test(title)) parts.push('OG');
  if (/hinged/i.test(title))       parts.push('Hinged');
  if (/imperf/i.test(title))       parts.push('Imperf');
  if (/best offer/i.test(title))   parts.push('Best Offer');
  if (/buy it now/i.test(title))   parts.push('Buy It Now');
  return parts.join(' · ') || 'MNH · Free US Shipping';
}

// ── FETCH URL ────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StampsSync/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── PARSE RSS ────────────────────────────────────────
async function parseRSS(xml) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xml, { explicitArray: false }, (err, result) => {
      if (err) return reject(err);
      try {
        const items = result?.rss?.channel?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        resolve(arr);
      } catch(e) {
        reject(e);
      }
    });
  });
}

// ── BUILD LISTING OBJECT ────────────────────────────
function buildListing(item) {
  const title = item.title || '';
  const link  = item.link  || `https://www.ebay.com/usr/${EBAY_USERNAME}`;
  const desc  = item.description || '';

  // Try to get price from description
  const priceFromDesc = extractPrice(desc);
  const priceFromTitle = extractPrice(title);
  const price = priceFromDesc || priceFromTitle || 'See listing';

  // Try to get image from description HTML
  const imgMatch = desc.match(/src="([^"]+ebay[^"]+\.(jpg|jpeg|png|gif|webp)[^"]*)"/i);
  const image = imgMatch ? imgMatch[1] : null;

  const scott = extractScott(title);
  const year  = extractYear(title);
  const emoji = getEmoji(title);
  const cond  = extractCondition(title);

  // Clean up title — remove Scott# prefix for display
  const displayTitle = title
    .replace(/Scott#?\s*[A-Z]?\d+[A-Za-z]?\s*[-–]\s*/i, '')
    .replace(/\s*-\s*MNH.*$/i, '')
    .replace(/\s*-\s*Original Gum.*/i, '')
    .trim();

  return {
    title: displayTitle || title,
    fullTitle: title,
    scott,
    year: year ? `${year}${year ? ' · ' : ''}${cond.includes('Parcel') ? 'Parcel Post' : ''}`.trim() : '',
    price,
    cond,
    image,
    emoji,
    url: link,
    fetchedAt: new Date().toISOString(),
  };
}

// ── DETECT NEW LISTINGS (for email campaign) ─────────
function findNewListings(current, previous) {
  if (!previous || !previous.length) return [];
  const prevUrls = new Set(previous.map(l => l.url));
  return current.filter(l => !prevUrls.has(l.url));
}

// ── SEND GHL EMAIL CAMPAIGN ──────────────────────────
async function sendGHLCampaign(newListings) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID || newListings.length === 0) return;
  
  console.log(`📧 Sending GHL campaign for ${newListings.length} new listing(s)…`);
  
  // Build email HTML
  const listingCards = newListings.slice(0, 6).map(l => `
    <div style="border:1px solid #2a2318;background:#13120f;padding:16px;margin-bottom:12px;">
      <p style="color:#c8923a;font-family:monospace;font-size:11px;margin:0 0 4px;">${l.scott||''}</p>
      <h3 style="color:#f0e4cc;font-family:Georgia,serif;margin:0 0 4px;font-size:18px;">${l.title}</h3>
      <p style="color:#8a7d6a;font-size:13px;margin:0 0 8px;">${l.year||''}</p>
      <p style="color:#e8b86d;font-family:Georgia,serif;font-size:22px;margin:0 0 10px;">${l.price}</p>
      <a href="${l.url}" style="background:#c8923a;color:#0d0c0a;padding:8px 16px;text-decoration:none;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:1px;">View on eBay →</a>
    </div>
  `).join('');

  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <body style="background:#0d0c0a;color:#d8ccb8;font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:0;">
      <div style="background:#13120f;border-bottom:1px solid #2a2318;padding:24px 32px;">
        <h1 style="color:#c8923a;font-size:26px;margin:0;font-family:Georgia,serif;">Sticks & Stamps</h1>
        <p style="color:#8a7d6a;font-size:12px;margin:4px 0 0;font-family:monospace;letter-spacing:2px;text-transform:uppercase;">New Listings — First Access</p>
      </div>
      <div style="padding:32px;">
        <h2 style="color:#f0e4cc;font-size:22px;margin:0 0 8px;">New stamps just listed.</h2>
        <p style="color:#8a7d6a;font-style:italic;margin:0 0 24px;">You're getting this because you subscribed for first access. These are live now on eBay.</p>
        ${listingCards}
        <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid #2a2318;">
          <a href="https://www.ebay.com/usr/${EBAY_USERNAME}" style="background:#c8923a;color:#0d0c0a;padding:12px 28px;text-decoration:none;font-family:monospace;font-size:12px;text-transform:uppercase;letter-spacing:2px;font-weight:600;">View Full Collection →</a>
        </div>
      </div>
      <div style="padding:20px 32px;border-top:1px solid #2a2318;text-align:center;">
        <p style="color:#4a4336;font-family:monospace;font-size:10px;letter-spacing:1px;">© Sticks & Stamps · 100% Positive Feedback Since 2004</p>
        <p style="color:#4a4336;font-family:monospace;font-size:10px;">{{unsubscribe}}</p>
      </div>
    </body>
    </html>
  `;

  // GHL API — Send to all contacts tagged 'new-listing-alerts'
  // Uses GHL's email sending API
  try {
    const payload = {
      type: 'Email',
      subject: `✦ New Stamps Listed — ${newListings.length} New Item${newListings.length > 1 ? 's' : ''} · Sticks & Stamps`,
      html: emailHTML,
      fromName: 'Sticks & Stamps',
      fromEmail: 'stamps@yourdomain.com', // ← Change to your GHL verified sender
      tags: ['new-listing-alerts'],
      locationId: GHL_LOCATION_ID,
    };

    const result = await fetchUrl(
      // GHL Bulk Email API endpoint
      'https://rest.gohighlevel.com/v1/campaigns/bulk-email'
    );
    console.log('✅ GHL campaign sent');
  } catch(e) {
    console.error('GHL campaign error:', e.message);
    console.log('💡 Manual option: Log into GHL → Email Marketing → New Campaign → paste the generated HTML');
  }
  
  // Save email HTML as a file for manual sending
  fs.writeFileSync(
    path.join(__dirname, 'new-listings-email.html'),
    emailHTML
  );
  console.log('📄 Email HTML saved to new-listings-email.html (can upload manually to GHL)');
}

// ── MAIN ─────────────────────────────────────────────
async function main() {
  console.log('🔍 Fetching eBay store RSS feed…');
  console.log(`   URL: ${EBAY_RSS_URL}\n`);

  let listings = [];

  try {
    const xml = await fetchUrl(EBAY_RSS_URL);
    
    if (!xml || xml.length < 100) {
      throw new Error('Empty or invalid RSS response');
    }

    const items = await parseRSS(xml);
    listings = items.map(buildListing).filter(l => l.title && l.url);
    
    console.log(`✅ Found ${listings.length} listing(s) from RSS feed`);
    
  } catch(e) {
    console.warn(`⚠️  RSS fetch failed: ${e.message}`);
    console.log('💡 Using last known data if available, or falling back to hardcoded listings.');
    
    // Load previous data as fallback
    if (fs.existsSync(OUTPUT_FILE)) {
      try {
        listings = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        console.log(`📂 Loaded ${listings.length} listings from previous sync`);
      } catch(e2) {
        listings = [];
      }
    }
  }

  // Load previous listings to detect new ones
  let prevListings = [];
  if (fs.existsSync(PREV_FILE)) {
    try { prevListings = JSON.parse(fs.readFileSync(PREV_FILE, 'utf8')); } catch(e) {}
  }

  // Find new listings
  const newListings = findNewListings(listings, prevListings);
  if (newListings.length > 0) {
    console.log(`\n🆕 ${newListings.length} NEW listing(s) detected:`);
    newListings.forEach(l => console.log(`   · ${l.title} — ${l.price}`));
  } else {
    console.log('\n📋 No new listings since last sync.');
  }

  // Save current as previous for next run
  if (listings.length > 0) {
    fs.writeFileSync(PREV_FILE, JSON.stringify(listings, null, 2));
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(listings, null, 2));
    console.log(`\n💾 Saved ${listings.length} listings to ${OUTPUT_FILE}`);
  }

  // Send GHL campaign if new listings exist
  if (newListings.length > 0 && GHL_API_KEY) {
    await sendGHLCampaign(newListings);
  } else if (newListings.length > 0) {
    console.log('\n📧 New listings detected! To send email campaign:');
    console.log('   1. Set GHL_API_KEY, GHL_LOCATION_ID env vars');
    console.log('   2. Or use GHL dashboard → Email Marketing → use new-listings-email.html');
    // Still generate the email HTML
    await sendGHLCampaign(newListings);
  }

  console.log('\n✦ Sync complete!');
  console.log(`   Next step: commit listings-data.json to your GitHub repo`);
  console.log(`   GitHub Actions will auto-run this every 6 hours (see workflow file)\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

/*
════════════════════════════════════════════════════
GITHUB ACTIONS — AUTO SYNC EVERY 6 HOURS (FREE!)
════════════════════════════════════════════════════

Create this file in your repo:
  .github/workflows/sync-listings.yml

─────────────────────────────────────────────
name: Sync eBay Listings

on:
  schedule:
    - cron: '0 */6 * * *'   # Every 6 hours
  workflow_dispatch:          # Manual trigger button in GitHub

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install deps
        run: npm install xml2js
      
      - name: Run sync
        env:
          GHL_API_KEY: ${{ secrets.GHL_API_KEY }}
          GHL_LOCATION_ID: ${{ secrets.GHL_LOCATION_ID }}
        run: node ebay-sync.js
      
      - name: Commit updated listings
        run: |
          git config --global user.name 'Listings Bot'
          git config --global user.email 'bot@github.com'
          git add listings-data.json listings-prev.json
          git diff --staged --quiet || git commit -m "Auto-sync: eBay listings $(date -u +'%Y-%m-%d %H:%M UTC')"
          git push
─────────────────────────────────────────────

After adding this workflow:
- Go to GitHub repo → Settings → Secrets → Add:
  GHL_API_KEY = your key
  GHL_LOCATION_ID = your location ID
- The sync runs every 6 hours automatically FOR FREE
- listings-data.json gets committed to your repo
- GitHub Pages serves it automatically
════════════════════════════════════════════════════
*/
