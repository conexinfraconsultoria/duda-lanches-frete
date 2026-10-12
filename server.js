/**
 * Backend de cálculo de frete - Duda Lanches
 * Calcula distância real por rota (ruas) e preço de entrega.
 * Chaves de API ficam apenas aqui (variáveis de ambiente).
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração (pode ser alterada via .env sem mexer no código)
const CONFIG = {
  storeAddress: process.env.STORE_ADDRESS || 'Centro, Tabuleiro do Norte, CE, Brasil',
  storeLat: process.env.STORE_LAT ? parseFloat(process.env.STORE_LAT) : null,
  storeLng: process.env.STORE_LNG ? parseFloat(process.env.STORE_LNG) : null,
  pricePerKm: parseFloat(process.env.PRICE_PER_KM) || 2.5,
  minFee: parseFloat(process.env.MIN_DELIVERY_FEE) || 5,
  maxDistanceKm: parseFloat(process.env.MAX_DISTANCE_KM) || 12,
  orsApiKey: process.env.ORS_API_KEY || '',
};

app.use(cors({
  origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || true),
}));
app.use(express.json({ limit: '32kb' }));

// Rate limit para proteger a API de mapas
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Muitas requisições. Aguarde um momento e tente novamente.' },
});
app.use('/api/', limiter);

// ---------- Helpers de geocoding e roteamento ----------

async function geocodeNominatim(address) {
  const url = `https://nominatim.openstreetmap.org/search?` + new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: 'br',
    addressdetails: '1',
  });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DudaLanchesDelivery/1.0 (contato@dudalanches.local)' },
  });
  if (!res.ok) throw new Error('Falha no geocoding (Nominatim)');
  const data = await res.json();
  if (!data || !data[0]) return null;
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    display: data[0].display_name,
  };
}

async function geocodeORS(address) {
  if (!CONFIG.orsApiKey) return null;
  const url = `https://api.openrouteservice.org/geocode/search?` + new URLSearchParams({
    api_key: CONFIG.orsApiKey,
    text: address,
    size: '1',
    'boundary.country': 'BR',
  });
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const feat = data.features && data.features[0];
  if (!feat) return null;
  const [lng, lat] = feat.geometry.coordinates;
  return { lat, lng, display: feat.properties.label };
}

async function geocode(address) {
  // Tenta ORS primeiro se tiver chave; senão Nominatim
  if (CONFIG.orsApiKey) {
    try {
      const r = await geocodeORS(address);
      if (r) return r;
    } catch (_) { /* fallback */ }
  }
  return geocodeNominatim(address);
}

async function routeDistanceORS(from, to) {
  if (!CONFIG.orsApiKey) return null;
  const url = 'https://api.openrouteservice.org/v2/directions/driving-car';
  const body = {
    coordinates: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': CONFIG.orsApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ORS directions: ${res.status} ${err}`);
  }
  const data = await res.json();
  const summary = data.routes && data.routes[0] && data.routes[0].summary;
  if (!summary) throw new Error('Rota não encontrada (ORS)');
  // distance em metros
  return summary.distance / 1000;
}

async function routeDistanceOSRM(from, to) {
  // Servidor demo público do OSRM (não use em produção de alto volume)
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Falha no cálculo de rota (OSRM)');
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes[0]) {
    throw new Error('Rota não encontrada entre os pontos');
  }
  return data.routes[0].distance / 1000; // km
}

async function getRouteDistanceKm(from, to) {
  if (CONFIG.orsApiKey) {
    try {
      return await routeDistanceORS(from, to);
    } catch (e) {
      console.warn('ORS falhou, tentando OSRM:', e.message);
    }
  }
  return routeDistanceOSRM(from, to);
}

function calcFee(distanceKm) {
  const raw = distanceKm * CONFIG.pricePerKm;
  return Math.max(CONFIG.minFee, Math.round(raw * 100) / 100);
}

// Cache simples da origem da loja (evita geocoding repetido)
let storeCoordsCache = null;

async function getStoreCoords() {
  if (CONFIG.storeLat != null && CONFIG.storeLng != null) {
    return { lat: CONFIG.storeLat, lng: CONFIG.storeLng, display: CONFIG.storeAddress };
  }
  if (storeCoordsCache) return storeCoordsCache;
  const geo = await geocode(CONFIG.storeAddress);
  if (!geo) throw new Error('Não foi possível localizar o endereço do estabelecimento. Verifique STORE_ADDRESS no .env');
  storeCoordsCache = geo;
  return geo;
}

// ---------- Endpoints ----------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasOrsKey: Boolean(CONFIG.orsApiKey),
    maxDistanceKm: CONFIG.maxDistanceKm,
    pricePerKm: CONFIG.pricePerKm,
    minFee: CONFIG.minFee,
  });
});

/**
 * POST /api/calcular-frete
 * Body: {
 *   cep?, rua, numero, bairro, cidade, complemento?,
 *   lat?, lng?   // opcional: se o cliente usou geolocalização
 * }
 */
app.post('/api/calcular-frete', async (req, res) => {
  try {
    const { cep, rua, numero, bairro, cidade, complemento, lat, lng } = req.body || {};

    let customerCoords = null;
    let addressDisplay = '';

    // Prioridade: coordenadas enviadas (geolocalização)
    if (typeof lat === 'number' && typeof lng === 'number' &&
        lat >= -35 && lat <= 5 && lng >= -75 && lng <= -30) {
      customerCoords = { lat, lng };
      addressDisplay = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    } else {
      // Monta endereço textual
      const parts = [rua, numero, bairro, cidade, 'CE', 'Brasil'].filter(Boolean);
      if (cep) parts.unshift(String(cep).replace(/\D/g, ''));
      if (complemento) parts.push(complemento);
      const fullAddress = parts.join(', ');

      if (!rua || !numero || !bairro || !cidade) {
        return res.status(400).json({
          error: 'Preencha rua, número, bairro e cidade para calcular o frete.',
        });
      }

      customerCoords = await geocode(fullAddress);
      if (!customerCoords) {
        return res.status(422).json({
          error: 'Não encontramos esse endereço. Verifique os dados ou use a localização do celular.',
        });
      }
      addressDisplay = customerCoords.display;
    }

    const store = await getStoreCoords();
    const distanceKm = await getRouteDistanceKm(store, customerCoords);

    if (distanceKm > CONFIG.maxDistanceKm) {
      return res.status(422).json({
        error: `Desculpe, não entregamos nessa região (distância aproximada ${distanceKm.toFixed(1)} km). Área máxima: ${CONFIG.maxDistanceKm} km.`,
        distanceKm: Math.round(distanceKm * 10) / 10,
        outOfRange: true,
      });
    }

    const fee = calcFee(distanceKm);

    // Resposta oficial – o frontend NÃO deve confiar em valores inventados
    res.json({
      ok: true,
      distanceKm: Math.round(distanceKm * 100) / 100,
      deliveryFee: fee,
      addressDisplay,
      maxDistanceKm: CONFIG.maxDistanceKm,
      pricePerKm: CONFIG.pricePerKm,
      minFee: CONFIG.minFee,
    });
  } catch (err) {
    console.error('Erro calcular-frete:', err.message);
    res.status(503).json({
      error: 'Não foi possível calcular a distância agora. Tente novamente em instantes.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// Serve o frontend estático (opcional – útil se você colocar o HTML em public/)
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

app.listen(PORT, () => {
  console.log(`Duda Lanches frete rodando em http://localhost:${PORT}`);
  console.log(`Config: R$ ${CONFIG.pricePerKm}/km | mínimo R$ ${CONFIG.minFee} | máx ${CONFIG.maxDistanceKm} km`);
  console.log(`ORS key: ${CONFIG.orsApiKey ? 'configurada' : 'não (usando OSRM público)'}`);
});
