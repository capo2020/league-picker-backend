import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3001;

// Cache per champion - only fetched on demand
const counterCache = {};
const fetchTimes = {};
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

const SLUG_MAP = {
  "Aurelion Sol": "aurelion-sol",
  "Bel'Veth": "bel-veth",
  "Cho'Gath": "cho-gath",
  "Dr. Mundo": "dr-mundo",
  "Jarvan IV": "jarvan-iv",
  "Kai'Sa": "kai-sa",
  "Kha'Zix": "kha-zix",
  "Kog'Maw": "kog-maw",
  "K'Sante": "k-sante",
  "LeBlanc": "leblanc",
  "Lee Sin": "lee-sin",
  "Master Yi": "master-yi",
  "Miss Fortune": "miss-fortune",
  "Nunu & Willump": "nunu-willump",
  "Rek'Sai": "rek-sai",
  "Renata Glasc": "renata-glasc",
  "Tahm Kench": "tahm-kench",
  "Twisted Fate": "twisted-fate",
  "Vel'Koz": "vel-koz",
  "Wukong": "wukong",
  "Xin Zhao": "xin-zhao",
  "Mel": "mel",
  "Yunara": "yunara",
  "Ambessa": "ambessa",
};

function getSlug(name) {
  if (SLUG_MAP[name]) return SLUG_MAP[name];
  return name.toLowerCase().replace(/[' .]/g, '-').replace(/--+/g, '-');
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchCounters(champName) {
  const slug = getSlug(champName);
  const url = `https://u.gg/lol/champions/${slug}/counter`;

  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];

    const html = await res.text();
    const $ = cheerio.load(html);
    const counters = [];

    $('a[href*="/lol/champions/"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (href.includes('/counter') && text && text.length > 1 && !text.includes('Counter')) {
        if (!counters.includes(text) && counters.length < 5) {
          counters.push(text);
        }
      }
    });

    return counters;
  } catch (e) {
    console.error(`Failed to fetch counters for ${champName}:`, e.message);
    return [];
  }
}

async function getCounters(champName) {
  const now = Date.now();
  // Return cache if fresh
  if (counterCache[champName] && now - fetchTimes[champName] < CACHE_TTL) {
    return counterCache[champName];
  }
  // Fetch fresh
  const counters = await fetchCounters(champName);
  counterCache[champName] = counters;
  fetchTimes[champName] = now;
  console.log(`Fetched ${champName}: ${counters.join(', ') || 'none'}`);
  return counters;
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    cachedChampions: Object.keys(counterCache).length,
  });
});

// Get counters for a specific champion
app.get('/counters/:champion', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const champ = decodeURIComponent(req.params.champion);
  const counters = await getCounters(champ);
  res.json({ champion: champ, counters });
});

// Get counters for multiple champions at once
app.get('/counters', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const picks = (req.query.picks || '').split(',').filter(Boolean).map(decodeURIComponent);
  if (!picks.length) return res.json({ suggestions: [] });

  const existingBans = (req.query.bans || '').split(',').filter(Boolean).map(decodeURIComponent);
  const seen = new Set([...picks, ...existingBans]);
  const suggestions = [];

  for (const pick of picks) {
    const counters = await getCounters(pick);
    for (const c of counters) {
      if (!seen.has(c) && suggestions.length < 5) {
        seen.add(c);
        suggestions.push({ name: c, counters: pick });
      }
    }
  }

  res.json({ suggestions });
});

app.listen(PORT, () => {
  console.log(`League Picker backend running on port ${PORT}`);
});
