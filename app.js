const state = { mode: 'auto', coords: null, placeName: '', restaurants: [], lastRestaurantId: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pickButton = $('#pickButton');
const resultSection = $('#resultSection');
const resultCard = $('#resultCard');
const addressInput = $('#addressInput');
const locationChip = $('#locationChip span');

$$('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    state.coords = null;
    $$('.mode-tab').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    $('#manualField').hidden = state.mode !== 'manual';
    if (state.mode === 'manual') addressInput.focus();
  });
});

addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') pickButton.click();
});

function setBusy(busy) {
  pickButton.disabled = busy;
  $('.button-label').innerHTML = busy
    ? '搵緊食肆 <span class="loading-dots"><i></i><i></i><i></i></span>'
    : '幫我揀！';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function showMessage(title, detail = '') {
  resultSection.hidden = false;
  resultCard.className = 'result-card is-message';
  resultCard.innerHTML = `<h2>${escapeHtml(title)}</h2>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}`;
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return { status: 'message', message: title, detail };
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 12000, maximumAge: 300000
    });
  });
}

async function locateAutomatically() {
  const position = await getCurrentPosition();
  const coords = { lat: position.coords.latitude, lon: position.coords.longitude, sr: 4326 };
  state.placeName = '你目前的位置';
  locationChip.textContent = state.placeName;
  return coords;
}

async function geocodeAddress(query) {
  try {
    const url = new URL('https://www.map.gov.hk/gs/api/v1.0.0/locationSearch');
    url.search = new URLSearchParams({ q: query });
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('landsd_geocode_failed');
    const places = await response.json();
    if (places.length) {
      const place = places[0];
      const x = Number(place.x);
      const y = Number(place.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('landsd_invalid_coordinates');
      state.placeName = place.nameZH || place.nameEN || place.addressZH || query;
      locationChip.textContent = state.placeName;
      return { x, y, sr: 2326, query };
    }
  } catch (error) {
    console.warn('Hong Kong location search unavailable; using OpenStreetMap fallback.', error);
  }
  return geocodeAddressWithOpenStreetMap(query);
}

async function geocodeAddressWithOpenStreetMap(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', 'accept-language': 'zh-Hant,zh,en' });
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('geocode_failed');
  const places = await response.json();
  if (!places.length) return null;
  state.placeName = places[0].display_name.split(',').slice(0, 2).join('，');
  locationChip.textContent = state.placeName;
  return { lat: Number(places[0].lat), lon: Number(places[0].lon), sr: 4326, query };
}

function haversine(a, b) {
  const toRad = (n) => n * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
}

async function fetchRestaurants(location, radius) {
  try {
    return await fetchFehdRestaurants(location, radius);
  } catch (error) {
    console.warn('FEHD restaurant search unavailable; using OpenStreetMap fallback.', error);
    const coords = await ensureWgs84Location(location);
    return fetchOpenStreetMapRestaurants(coords, radius);
  }
}

async function fetchFehdRestaurants(location, radius) {
  const geometry = location.sr === 2326
    ? `${location.x},${location.y}`
    : `${location.lon},${location.lat}`;
  const url = new URL('https://portal.csdi.gov.hk/server/rest/services/common/fehd_rcd_1630036390312_58893/FeatureServer/0/query');
  url.search = new URLSearchParams({
    where: '1=1',
    geometry,
    geometryType: 'esriGeometryPoint',
    inSR: String(location.sr || 4326),
    distance: String(radius),
    units: 'esriSRUnit_Meter',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,NSEARCH03_TC,NSEARCH03_EN,ADDRESS_TC,ADDRESS_EN,EASTING,NORTHING',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json'
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`fehd_${response.status}`);
  const data = await response.json();
  if (data.error || !Array.isArray(data.features)) throw new Error('fehd_invalid_response');
  return normalizeFehdRestaurants(data.features, location, radius);
}

function normalizeFehdRestaurants(features, location, radius) {
  return features.map((item) => {
    const attributes = item.attributes || {};
    const lat = Number(item.geometry?.y);
    const lon = Number(item.geometry?.x);
    const nameTc = attributes.NSEARCH03_TC?.trim() || '';
    const nameEn = attributes.NSEARCH03_EN?.trim() || '';
    const addressTc = attributes.ADDRESS_TC?.trim() || '';
    const addressEn = attributes.ADDRESS_EN?.trim() || '';
    const easting = Number(attributes.EASTING);
    const northing = Number(attributes.NORTHING);
    const distance = Number.isFinite(location.lat)
      ? haversine(location, { lat, lon })
      : Number.isFinite(easting) && Number.isFinite(northing)
        ? Math.round(Math.hypot(easting - location.x, northing - location.y))
        : null;
    return {
      id: `fehd-${attributes.OBJECTID}`,
      name: nameTc || nameEn || '未提供店名',
      nameEn: nameTc && nameEn && nameTc.toLowerCase() !== nameEn.toLowerCase() ? nameEn : '',
      address: addressTc || state.placeName,
      addressEn: addressTc && addressEn && addressTc.toLowerCase() !== addressEn.toLowerCase() ? addressEn : '',
      lat,
      lon,
      distance,
      searchRadius: radius,
      source: 'fehd'
    };
  }).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon));
}

async function ensureWgs84Location(location) {
  if (Number.isFinite(location.lat) && Number.isFinite(location.lon)) return location;
  const fallback = await geocodeAddressWithOpenStreetMap(location.query || state.placeName);
  if (!fallback) throw new Error('fallback_geocode_failed');
  return fallback;
}

async function fetchOpenStreetMapRestaurants(coords, radius) {
  const query = `[out:json][timeout:20];(nwr["amenity"~"^(restaurant|fast_food|cafe|food_court)$"](around:${radius},${coords.lat},${coords.lon}););out center tags;`;
  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`overpass_${response.status}`);
    const data = await response.json();
    return normalizeOverpassRestaurants(data.elements, coords, radius);
  } catch (error) {
    console.warn('Primary restaurant search unavailable; using place-search fallback.', error);
    return fetchRestaurantFallback(coords, radius);
  }
}

function normalizeOverpassRestaurants(elements, coords, radius) {
  return elements.map((item) => {
    const lat = item.lat ?? item.center?.lat;
    const lon = item.lon ?? item.center?.lon;
    return {
      id: `${item.type}-${item.id}`,
      name: item.tags?.name || item.tags?.['name:zh'] || item.tags?.['name:en'] || '未命名食肆',
      nameEn: '',
      cuisine: item.tags?.cuisine?.split(';').map(formatCuisine).join('・') || formatAmenity(item.tags?.amenity),
      address: [item.tags?.['addr:housenumber'], item.tags?.['addr:street']].filter(Boolean).join(' ') || state.placeName,
      addressEn: '',
      lat, lon,
      distance: haversine(coords, { lat, lon }),
      searchRadius: radius,
      source: 'osm'
    };
  }).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon) && item.distance <= radius);
}

async function fetchRestaurantFallback(coords, radius) {
  const latDelta = radius / 111320;
  const lonDelta = radius / (111320 * Math.max(.2, Math.cos(coords.lat * Math.PI / 180)));
  const viewbox = [coords.lon - lonDelta, coords.lat + latDelta, coords.lon + lonDelta, coords.lat - latDelta].join(',');
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: 'restaurant', format: 'jsonv2', limit: '40', bounded: '1', viewbox, 'accept-language': 'zh-Hant,zh,en' });
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('restaurant_search_failed');
  const places = await response.json();
  return places.map((item) => {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    return {
      id: `place-${item.place_id}`,
      name: item.name || item.display_name?.split(',')[0] || '未命名食肆',
      nameEn: '',
      cuisine: formatAmenity(item.type === 'cafe' ? 'cafe' : 'restaurant'),
      address: item.display_name?.split(',').slice(1, 3).join('，').trim() || state.placeName,
      addressEn: '',
      lat, lon,
      distance: haversine(coords, { lat, lon }),
      searchRadius: radius,
      source: 'osm'
    };
  }).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon) && item.distance <= radius);
}

function formatAmenity(value) {
  return ({ restaurant: '餐廳', fast_food: '快餐', cafe: '咖啡店', food_court: '美食廣場' })[value] || '食肆';
}

function formatCuisine(value = '') {
  const labels = { chinese: '中菜', cantonese: '粵菜', japanese: '日本菜', korean: '韓國菜', thai: '泰國菜', italian: '意大利菜', indian: '印度菜', pizza: '薄餅', burger: '漢堡', coffee_shop: '咖啡', seafood: '海鮮', noodle: '麵食', dim_sum: '點心', regional: '地道菜' };
  return labels[value.trim()] || value.trim().replaceAll('_', ' ');
}

function selectRestaurant(restaurants) {
  const choices = restaurants.length > 1 ? restaurants.filter((item) => item.id !== state.lastRestaurantId) : restaurants;
  const picked = choices[Math.floor(Math.random() * choices.length)];
  state.lastRestaurantId = picked.id;
  return picked;
}

function renderRestaurant(restaurant) {
  const mapUrl = `https://www.openstreetmap.org/?mlat=${restaurant.lat}&mlon=${restaurant.lon}#map=19/${restaurant.lat}/${restaurant.lon}`;
  const distanceLabel = Number.isFinite(restaurant.distance)
    ? `約 ${restaurant.distance < 1000 ? `${restaurant.distance} 米` : `${(restaurant.distance / 1000).toFixed(1)} 公里`}`
    : '距離未能計算';
  resultSection.hidden = false;
  resultCard.className = 'result-card';
  resultCard.innerHTML = `
    <h2>${escapeHtml(restaurant.name)}</h2>
    ${restaurant.nameEn ? `<p class="result-name-en">${escapeHtml(restaurant.nameEn)}</p>` : ''}
    <div class="result-meta">
      <span>${escapeHtml(distanceLabel)}</span>
      ${restaurant.address ? `<span>${escapeHtml(restaurant.address)}</span>` : ''}
    </div>
    <div class="result-actions">
      <a href="${mapUrl}" target="_blank" rel="noreferrer">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>
        地圖睇路線
      </a>
      <button type="button" id="pickAgain">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>
        再揀一間
      </button>
    </div>`;
  $('#pickAgain').addEventListener('click', () => renderRestaurant(selectRestaurant(state.restaurants)));
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return { status: 'picked', restaurant: { name: restaurant.name, nameEn: restaurant.nameEn, address: restaurant.address, addressEn: restaurant.addressEn, distance: restaurant.distance, searchRadius: restaurant.searchRadius, source: restaurant.source, mapUrl } };
}

async function findAndPick() {
  setBusy(true);
  resultSection.hidden = true;
  try {
    let coords;
    if (state.mode === 'manual') {
      const query = addressInput.value.trim();
      if (!query) return showMessage('請先輸入你的位置', '例如：旺角朗豪坊、銅鑼灣時代廣場');
      coords = await geocodeAddress(query);
      if (!coords) return showMessage('找不到這個位置', '試試輸入較完整的地址或地標。');
    } else {
      try { coords = state.coords || await locateAutomatically(); }
      catch { return showMessage('未能取得你的位置', '請允許瀏覽器使用定位，或改為自行輸入位置。'); }
    }
    state.coords = coords;
    const radius = Number($('input[name="distance"]:checked').value);
    state.restaurants = await fetchRestaurants(coords, radius);
    if (!state.restaurants.length) return showMessage('附近沒有任何食肆');
    return renderRestaurant(selectRestaurant(state.restaurants));
  } catch (error) {
    console.error(error);
    return showMessage('暫時未能搜尋餐廳', '請檢查網絡連線，稍後再試。');
  } finally { setBusy(false); }
}

pickButton.addEventListener('click', findAndPick);

window.restaurantPicker = {
  setLocationMode(mode) {
    const target = $(`.mode-tab[data-mode="${mode}"]`);
    if (!target) throw new Error('mode must be auto or manual');
    target.click(); return { mode };
  },
  setDistance(metres) {
    const input = $(`input[name="distance"][value="${metres}"]`);
    if (!input) throw new Error('distance must be 50, 100, 500 or 1000');
    input.checked = true; return { distance: Number(metres) };
  },
  pick: findAndPick
};

const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    void Promise.resolve(modelContext.registerTool({
      name: 'configure_and_pick_restaurant',
      title: '設定並隨機挑選餐廳',
      description: '設定定位方式及步行距離，然後從附近食肆隨機挑選一間，並把結果顯示在頁面。手動模式必須提供 address。',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'manual'], description: '使用裝置定位或手動地址' },
          distance: { type: 'integer', enum: [50, 100, 500, 1000], description: '搜尋半徑（米）' },
          address: { type: 'string', minLength: 1, description: '手動模式使用的地址或地標' }
        },
        required: ['mode', 'distance'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        if (!input || !['auto', 'manual'].includes(input.mode)) throw new Error('mode must be auto or manual');
        if (![50, 100, 500, 1000].includes(input.distance)) throw new Error('distance must be 50, 100, 500 or 1000');
        if (input.mode === 'manual' && (typeof input.address !== 'string' || !input.address.trim())) throw new Error('address is required in manual mode');
        window.restaurantPicker.setLocationMode(input.mode);
        window.restaurantPicker.setDistance(input.distance);
        if (input.mode === 'manual') addressInput.value = input.address.trim();
        return await findAndPick();
      }
    }, { signal: lifecycle.signal })).catch((error) => console.warn('WebMCP registration failed', error));
  } catch (error) {
    console.warn('WebMCP registration failed', error);
  }
}
