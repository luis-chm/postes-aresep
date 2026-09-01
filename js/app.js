proj4.defs("EPSG:5367", "+proj=tmerc +lat_0=0 +lon_0=-84 +k=0.9999 +x_0=500000 +y_0=0 +ellps=WGS84 +units=m +no_defs");

const OP_COLORS = {
  ICE: '#f5c518', CNFL: '#e8833a', COOPELESCA: '#4caf6d',
  COOPEGUANACASTE: '#1fb6a8', JASEC: '#4c8df5', COOPESANTOS: '#7fd1e0',
  ESPH: '#a76cf2', COOPEALFARORUIZ: '#e15fb0'
};
function colorFor(op){
  if(OP_COLORS[op]) return OP_COLORS[op];
  let h=0; for(const c of op) h=(h*31+c.charCodeAt(0))%360;
  return `hsl(${h},65%,60%)`;
}

const map = L.map('map',{zoomControl:false}).setView([9.75,-84.0],8);
L.control.zoom({position:'bottomright'}).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap contributors', maxZoom:19
}).addTo(map);

map.on('mousemove', e=>{
  document.getElementById('wgsVal').textContent = e.latlng.lat.toFixed(5)+', '+e.latlng.lng.toFixed(5);
  try{
    const [x,y] = proj4('WGS84','EPSG:5367',[e.latlng.lng, e.latlng.lat]);
    document.getElementById('crtmVal').textContent = x.toFixed(1)+', '+y.toFixed(1);
  }catch(err){}
});

const input = document.getElementById('districtInput');
const btn = document.getElementById('searchBtn');
const statusText = document.getElementById('statusText');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');

function showState(state){
  emptyEl.style.display = state==='empty' ? 'flex':'none';
  errorEl.style.display = state==='error' ? 'flex':'none';
}
showState('empty');

// Primero intenta el proxy propio (Cloudflare Worker): sin límite de tamaño,
// sin rate-limit compartido con otras apps, y control total. Si por alguna
// razón no responde, cae a proxies públicos como respaldo.
const MY_WORKER = 'https://postes-aresep-proxy.luischavesmora.workers.dev/';

const CORS_PROXIES = [
  u => MY_WORKER + '?url=' + encodeURIComponent(u),
  u => u, // directo, por si ARESEP algún día habilita CORS
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
];

async function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  try{
    return await fetch(url, {signal: ctrl.signal});
  }finally{
    clearTimeout(t);
  }
}

async function fetchJson(url, onAttempt){
  let lastErr;
  for(let pass=0; pass<2; pass++){ // retry the whole proxy list once
    for(const buildUrl of CORS_PROXIES){
      const attemptUrl = buildUrl(url);
      try{
        if(onAttempt) onAttempt(attemptUrl);
        const res = await fetchWithTimeout(attemptUrl, 8000);
        if(!res.ok) throw new Error('HTTP '+res.status);
        const text = await res.text();
        // allorigins /get wraps the payload as {"contents":"<json string>"}
        try{
          const parsed = JSON.parse(text);
          if(parsed && typeof parsed.contents === 'string'){
            return JSON.parse(parsed.contents);
          }
          return parsed;
        }catch(parseErr){
          throw new Error('Respuesta no era JSON válido');
        }
      }catch(err){ lastErr = err; }
    }
  }
  throw lastErr;
}

function tryParseCoords(str){
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if(!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2])];
}

// Se cargan de forma asíncrona en init() desde data/division-tree.json y
// data/distritos.geojson — ver el final de este archivo.
let DIVISION_TREE = {};
let DISTRICT_POLYGONS = null;

function normalizeDistrict(name){
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
}

// --- Emparejamiento difuso contra la lista oficial de distritos (INEC/DTA) ---
// Nominatim (OpenStreetMap) devuelve nombres de barrios/zonas que no siempre
// coinciden exactamente con el nombre oficial del distrito que espera ARESEP.
// En vez de usar ese texto tal cual, lo comparamos contra los 474 distritos
// oficiales y usamos el más parecido (opcionalmente acotado por el cantón
// que Nominatim también sugiere), para maximizar la probabilidad de acierto.

function levenshtein(a, b){
  const m = a.length, n = b.length;
  if(m===0) return n;
  if(n===0) return m;
  let prev = Array.from({length:n+1}, (_,j)=>j);
  for(let i=1;i<=m;i++){
    const cur=[i];
    for(let j=1;j<=n;j++){
      cur[j] = a[i-1]===b[j-1] ? prev[j-1] : 1+Math.min(prev[j-1],prev[j],cur[j-1]);
    }
    prev = cur;
  }
  return prev[n];
}

function strSimilarity(a, b){
  if(!a || !b) return 0;
  if(a===b) return 1;
  if(a.includes(b) || b.includes(a)){
    return 0.82 + 0.15*(Math.min(a.length,b.length)/Math.max(a.length,b.length));
  }
  const d = levenshtein(a,b);
  return 1 - d/Math.max(a.length,b.length);
}

const DISTRICT_INDEX = [];
function buildDistrictIndex(){
  DISTRICT_INDEX.length = 0;
  for(const prov in DIVISION_TREE){
    for(const canton in DIVISION_TREE[prov]){
      for(const dist of DIVISION_TREE[prov][canton]){
        DISTRICT_INDEX.push({
          dist, canton, provincia: prov,
          distNorm: normalizeDistrict(dist),
          cantonNorm: normalizeDistrict(canton)
        });
      }
    }
  }
}

// Busca el distrito oficial más parecido a lo que devolvió el geocodificador.
// Si hay una pista de cantón, primero acota la búsqueda a ese cantón.
function findBestDistrict(distGuessRaw, cantonGuessRaw){
  if(!distGuessRaw && !cantonGuessRaw) return null;
  const distGuess = distGuessRaw ? normalizeDistrict(distGuessRaw) : '';
  const cantonGuess = cantonGuessRaw ? normalizeDistrict(cantonGuessRaw) : '';

  let pool = DISTRICT_INDEX;
  if(cantonGuess){
    let bestCanton=null, bestCantonScore=0;
    const seen = new Set();
    for(const e of DISTRICT_INDEX){
      if(seen.has(e.cantonNorm)) continue;
      seen.add(e.cantonNorm);
      const s = strSimilarity(e.cantonNorm, cantonGuess);
      if(s>bestCantonScore){ bestCantonScore=s; bestCanton=e.cantonNorm; }
    }
    if(bestCanton && bestCantonScore>0.55){
      pool = DISTRICT_INDEX.filter(e=>e.cantonNorm===bestCanton);
    }
  }

  if(!distGuess) return pool[0] || null;

  const exact = pool.find(e=>e.distNorm===distGuess);
  if(exact) return exact;

  let best=null, bestScore=0;
  for(const e of pool){
    const s = strSimilarity(e.distNorm, distGuess);
    if(s>bestScore){ bestScore=s; best=e; }
  }
  if(best && bestScore>=0.5) return best;

  // último recurso: buscar en todo el país, no solo en el cantón sugerido
  if(pool!==DISTRICT_INDEX){
    best=null; bestScore=0;
    for(const e of DISTRICT_INDEX){
      const s = strSimilarity(e.distNorm, distGuess);
      if(s>bestScore){ bestScore=s; best=e; }
    }
    if(best && bestScore>=0.5) return best;
  }
  return null;
}

async function reverseGeocodeAddress(lat, lon){
  try{
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`);
    const data = await res.json();
    return data.address || {};
  }catch(err){ return {}; }
}

// --- Ubicación por polígono: determina el distrito exacto donde cae una
// coordenada usando los límites oficiales, sin depender de un servicio
// externo de geocodificación. Es instantáneo (todo corre en el navegador)
// y siempre da el distrito correcto según la geometría real, en vez de una
// adivinanza por texto. ---

function pointInRing(pt, ring){
  let inside = false;
  for(let i=0, j=ring.length-1; i<ring.length; j=i++){
    const xi=ring[i][0], yi=ring[i][1];
    const xj=ring[j][0], yj=ring[j][1];
    const intersect = ((yi>pt[1]) !== (yj>pt[1])) &&
      (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi);
    if(intersect) inside = !inside;
  }
  return inside;
}

// coords: anillos de un Polygon → [exterior, hueco1, hueco2, ...]
function pointInPolygonCoords(pt, coords){
  if(!pointInRing(pt, coords[0])) return false;
  for(let i=1;i<coords.length;i++){
    if(pointInRing(pt, coords[i])) return false; // cae en un hueco
  }
  return true;
}

// Busca en qué distrito cae exactamente la coordenada (contención estricta).
function findDistrictByPoint(lat, lon){
  if(!DISTRICT_POLYGONS) return null;
  const pt = [lon, lat];
  for(const feat of DISTRICT_POLYGONS.features){
    const geom = feat.geometry;
    if(geom.type === 'Polygon'){
      if(pointInPolygonCoords(pt, geom.coordinates)) return feat.properties;
    }else if(geom.type === 'MultiPolygon'){
      for(const polyCoords of geom.coordinates){
        if(pointInPolygonCoords(pt, polyCoords)) return feat.properties;
      }
    }
  }
  return null;
}

// Respaldo geométrico: si el punto no cayó estrictamente dentro de ningún
// polígono (posible cerca de un borde, por la simplificación de geometría),
// usa el distrito cuyo borde esté más cerca. Sigue siendo 100% local.
function nearestDistrictByPoint(lat, lon){
  if(!DISTRICT_POLYGONS) return null;
  const pt = [lon, lat];
  let best=null, bestDistSq=Infinity;
  for(const feat of DISTRICT_POLYGONS.features){
    const geom = feat.geometry;
    const polys = geom.type==='Polygon' ? [geom.coordinates] : geom.coordinates;
    for(const polyCoords of polys){
      const ring = polyCoords[0];
      for(const c of ring){
        const dx=c[0]-pt[0], dy=c[1]-pt[1];
        const d = dx*dx+dy*dy;
        if(d<bestDistSq){ bestDistSq=d; best=feat.properties; }
      }
    }
  }
  return best;
}

// --- Estado: un "lote" por distrito cargado. Permite cargar/quitar cada
// distrito de forma independiente (necesario para el árbol de checkboxes),
// sin perder los demás que estén en el mapa. ---
const districtBatches = {}; // key: distrito normalizado -> {label, rows, markers}
const operatorEnabled = {}; // key: operador -> bool (default true)

function isOperatorEnabled(op){ return operatorEnabled[op] !== false; }

function applyMarkerVisibility(){
  for(const key in districtBatches){
    for(const m of districtBatches[key].markers){
      const should = isOperatorEnabled(m._op);
      const has = map.hasLayer(m);
      if(should && !has) m.addTo(map);
      else if(!should && has) map.removeLayer(m);
    }
  }
}

function renderBatch(rows){
  const markers = [], bounds = [];
  for(const r of rows){
    const x = parseFloat(r.coordenadaX), y = parseFloat(r.coordenadaY);
    if(isNaN(x) || isNaN(y)) continue;
    const [lon, lat] = proj4('EPSG:5367','WGS84',[x,y]);
    const op = r.operador || 'N/D';
    const marker = L.circleMarker([lat,lon],{
      radius:5, weight:1, color:'#0d1116', fillColor:colorFor(op), fillOpacity:.9
    }).bindPopup(
      `<div class="popup-op">${op}</div><div class="popup-loc">${r.distrito||''}, ${r.canton||''}, ${r.provincia||''}</div>`
    );
    marker._op = op;
    if(isOperatorEnabled(op)) marker.addTo(map);
    markers.push(marker);
    bounds.push([lat,lon]);
  }
  return {markers, bounds};
}

function rebuildLegend(){
  const counts = {};
  for(const batch of Object.values(districtBatches)){
    for(const r of batch.rows){
      const op = r.operador || 'N/D';
      counts[op] = (counts[op]||0)+1;
    }
  }
  const legend = document.getElementById('legend');
  const list = document.getElementById('legendList');
  list.innerHTML = '';
  const ops = Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
  for(const op of ops){
    const row = document.createElement('label');
    row.className = 'legend-row';
    row.innerHTML = `
      <input type="checkbox" ${isOperatorEnabled(op)?'checked':''}>
      <span class="swatch" style="background:${colorFor(op)}"></span>
      <span class="legend-name">${op}</span>
      <span class="legend-count">${counts[op]}</span>`;
    row.querySelector('input').addEventListener('change', e=>{
      operatorEnabled[op] = e.target.checked;
      applyMarkerVisibility();
    });
    list.appendChild(row);
  }
  legend.style.display = ops.length ? 'block' : 'none';
}

function refreshStatus(){
  const total = Object.values(districtBatches).reduce((s,b)=>s+b.rows.length,0);
  const labels = Object.values(districtBatches).map(b=>b.label);
  statusText.textContent = labels.length ? (total + ' postes · ' + labels.join(', ')) : '';
  const badge = document.getElementById('districtBadge');
  const n = Object.keys(districtBatches).length;
  badge.textContent = n;
  badge.style.display = n ? 'flex' : 'none';
}

function setTreeChecked(key, checked){
  document.querySelectorAll('.dp-distrito-row[data-key="'+CSS.escape(key)+'"]').forEach(row=>{
    row.querySelector('input').checked = checked;
    row.classList.toggle('active', checked);
  });
}

// Carga (si no está ya cargado) los postes de un distrito y los agrega al mapa.
// Devuelve 'ok' | 'empty' | 'error'.
async function loadDistrict(distName, opts={}){
  const key = normalizeDistrict(distName);
  if(districtBatches[key]){
    if(opts.fitBounds !== false){
      const bounds = districtBatches[key].markers.map(m=>m.getLatLng());
      if(bounds.length) map.fitBounds(bounds, {padding:[30,30]});
    }
    return 'ok';
  }

  const url = 'https://datos.aresep.go.cr/ws.datosabiertos/Services/IE/Electricidad.svc/ObtenerInformacionPostesMapa/'+encodeURIComponent(key);
  document.getElementById('rawLink').href = url;
  statusText.textContent = 'Consultando '+(opts.label||distName)+'...';
  showState(null);
  try{
    const json = await fetchJson(url, (attemptUrl)=>{
      const via = attemptUrl===url ? 'directo' : new URL(attemptUrl).hostname;
      statusText.textContent = 'Consultando ('+via+')...';
    });
    const rows = json.value || [];
    if(!rows.length){
      refreshStatus();
      return 'empty';
    }
    const {markers, bounds} = renderBatch(rows);
    districtBatches[key] = {label: opts.label || distName, rows, markers};
    rebuildLegend();
    refreshStatus();
    setTreeChecked(key, true);
    if(opts.fitBounds !== false && bounds.length) map.fitBounds(bounds, {padding:[30,30]});
    return 'ok';
  }catch(err){
    refreshStatus();
    return 'error';
  }
}

function unloadDistrict(key){
  const batch = districtBatches[key];
  if(!batch) return;
  for(const m of batch.markers) if(map.hasLayer(m)) map.removeLayer(m);
  delete districtBatches[key];
  rebuildLegend();
  refreshStatus();
  setTreeChecked(key, false);
  if(!Object.keys(districtBatches).length) showState('empty');
}

function clearAllDistricts(){
  Object.keys(districtBatches).forEach(unloadDistrict);
}

let searchMarker = null;
async function goToCoords(lat, lon){
  if(searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.circleMarker([lat,lon], {
    radius:9, weight:2, color:'#fff', fillColor:'#f5c518', fillOpacity:1
  }).addTo(map);
  const [x,y] = proj4('WGS84','EPSG:5367',[lon,lat]);
  searchMarker.bindPopup(
    `<div class="popup-op">Coordenada buscada</div>`+
    `<div class="popup-loc">WGS84: ${lat.toFixed(5)}, ${lon.toFixed(5)}<br>CRTM05: ${x.toFixed(1)}, ${y.toFixed(1)}</div>`
  ).openPopup();
  map.setView([lat,lon], 15);
  showState(null);

  statusText.textContent = 'Ubicando distrito...';

  // 1) Local e instantáneo: ¿en qué polígono oficial cae este punto?
  let match = null;
  const geoProps = findDistrictByPoint(lat, lon) || nearestDistrictByPoint(lat, lon);
  if(geoProps){
    match = {dist: geoProps.distrito, canton: geoProps.canton, provincia: geoProps.provincia};
  }else{
    // 2) Respaldo (solo si los polígonos no cargaron): Nominatim + comparación difusa
    const addr = await reverseGeocodeAddress(lat, lon);
    const distGuess = addr.suburb || addr.city_district || addr.village || addr.town || addr.quarter || addr.neighbourhood || null;
    const cantonGuess = addr.county || addr.city || addr.municipality || null;
    if(distGuess || cantonGuess){
      match = findBestDistrict(distGuess, cantonGuess);
      if(!match) match = {dist: distGuess || cantonGuess, canton: '', provincia: ''};
    }
  }

  if(!match){
    statusText.textContent = 'Ubicación: '+lat.toFixed(5)+', '+lon.toFixed(5)+' (no se pudo identificar el distrito)';
    return;
  }

  const label = match.canton ? `${match.dist} (${match.canton})` : match.dist;

  if(!document.getElementById('accumulate').checked) clearAllDistricts();

  statusText.textContent = 'Buscando postes en '+label+'...';
  const result = await loadDistrict(match.dist, {label, fitBounds:false});
  if(result==='ok'){
    map.setView([lat,lon], 15);
  }else if(result==='empty'){
    statusText.textContent = 'Ubicación: '+label+' (sin postes registrados con ese nombre)';
  }else{
    statusText.textContent = 'Ubicación: '+lat.toFixed(5)+', '+lon.toFixed(5)+' — no se pudieron cargar los postes de '+label;
  }
}

async function search(){
  const raw = input.value.trim();
  if(!raw) return;
  const coords = tryParseCoords(raw);
  if(coords){
    btn.disabled = true;
    await goToCoords(coords[0], coords[1]);
    btn.disabled = false;
    return;
  }

  btn.disabled = true;
  if(!document.getElementById('accumulate').checked) clearAllDistricts();
  statusText.textContent = 'Consultando...';
  showState(null);

  const result = await loadDistrict(raw, {label: raw.toUpperCase()});
  if(result==='empty'){
    document.getElementById('errorDetail').textContent =
      'La API respondió, pero no hay postes registrados para "'+normalizeDistrict(raw)+'". Revisá la ortografía, o abrí el panel de Distritos (☰) para elegir el nombre oficial exacto.';
    showState('error');
  }else if(result==='error'){
    document.getElementById('errorDetail').textContent =
      'La API de ARESEP no respondió, ni directo ni a través de los proxies. Probá de nuevo en un momento.';
    showState('error');
  }
  btn.disabled = false;
}

// --- Árbol plegable Provincia > Cantón > Distrito con checkboxes ---
function buildDistrictTree(){
  const container = document.getElementById('districtTree');
  const frag = document.createDocumentFragment();
  for(const prov of Object.keys(DIVISION_TREE).sort()){
    const provDetails = document.createElement('details');
    provDetails.className = 'dp-provincia';
    const provSummary = document.createElement('summary');
    provSummary.textContent = prov;
    provDetails.appendChild(provSummary);

    for(const canton of Object.keys(DIVISION_TREE[prov]).sort()){
      const cantonDetails = document.createElement('details');
      cantonDetails.className = 'dp-canton';
      const cantonSummary = document.createElement('summary');
      cantonSummary.innerHTML = `<span>${canton}</span><span class="dp-canton-count">${DIVISION_TREE[prov][canton].length}</span>`;
      cantonDetails.appendChild(cantonSummary);

      for(const dist of DIVISION_TREE[prov][canton]){
        const key = normalizeDistrict(dist);
        const row = document.createElement('label');
        row.className = 'dp-distrito-row';
        row.dataset.key = key;
        row.dataset.searchtext = normalizeDistrict(dist+' '+canton+' '+prov);
        row.innerHTML = `<input type="checkbox" data-key="${key}"><span>${dist}</span>`;
        row.querySelector('input').addEventListener('change', async (e)=>{
          const checked = e.target.checked;
          if(checked){
            row.classList.add('active');
            if(!document.getElementById('accumulate').checked) clearAllDistricts();
            const result = await loadDistrict(dist, {label: `${dist} (${canton})`});
            if(result!=='ok'){
              e.target.checked = false;
              row.classList.remove('active');
              if(result==='empty') statusText.textContent = 'Sin postes registrados para '+dist+' ('+canton+')';
            }
          }else{
            unloadDistrict(key);
          }
        });
        cantonDetails.appendChild(row);
      }
      provDetails.appendChild(cantonDetails);
    }
    frag.appendChild(provDetails);
  }
  container.appendChild(frag);
}

const districtPanel = document.getElementById('districtPanel');
document.getElementById('districtToggleBtn').addEventListener('click', ()=>{
  districtPanel.classList.toggle('open');
});
document.getElementById('districtCloseBtn').addEventListener('click', ()=>{
  districtPanel.classList.remove('open');
});

document.getElementById('districtFilter').addEventListener('input', (e)=>{
  const q = normalizeDistrict(e.target.value.trim());
  const rows = document.querySelectorAll('.dp-distrito-row');
  const cantons = document.querySelectorAll('.dp-canton');
  const provs = document.querySelectorAll('.dp-provincia');
  if(!q){
    rows.forEach(r=>r.classList.remove('dp-hidden'));
    cantons.forEach(c=>{c.classList.remove('dp-hidden'); c.open=false;});
    provs.forEach(p=>{p.classList.remove('dp-hidden'); p.open=false;});
    return;
  }
  rows.forEach(row=>{
    row.classList.toggle('dp-hidden', !row.dataset.searchtext.includes(q));
  });
  cantons.forEach(canton=>{
    const anyVisible = !!canton.querySelector('.dp-distrito-row:not(.dp-hidden)');
    canton.classList.toggle('dp-hidden', !anyVisible);
    canton.open = anyVisible;
  });
  provs.forEach(prov=>{
    const anyVisible = !!prov.querySelector('.dp-canton:not(.dp-hidden)');
    prov.classList.toggle('dp-hidden', !anyVisible);
    prov.open = anyVisible;
  });
});

btn.addEventListener('click', search);
input.addEventListener('keydown', e=>{ if(e.key==='Enter') search(); });

const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', ()=>{
  const light = document.body.classList.toggle('light');
  themeBtn.textContent = light ? '☀ Claro' : '☾ Oscuro';
});

// --- Inicialización: carga los datos geográficos (árbol de distritos y
// polígonos oficiales) antes de habilitar la búsqueda. Son ~1.2MB en total
// (comprimidos por el navegador a unos ~350KB), se cargan en paralelo. ---
async function init(){
  btn.disabled = true;
  statusText.textContent = 'Cargando datos geográficos...';
  try{
    const [treeRes, geoRes] = await Promise.all([
      fetch('data/division-tree.json'),
      fetch('data/distritos.geojson')
    ]);
    if(!treeRes.ok || !geoRes.ok) throw new Error('HTTP error');
    DIVISION_TREE = await treeRes.json();
    DISTRICT_POLYGONS = await geoRes.json();
    buildDistrictIndex();
    buildDistrictTree();
    statusText.textContent = '';
  }catch(err){
    statusText.textContent = 'No se pudieron cargar los datos geográficos (data/division-tree.json y data/distritos.geojson). El árbol de distritos y la precisión por coordenadas no estarán disponibles; la búsqueda por texto sigue funcionando.';
  }
  btn.disabled = false;
}
init();