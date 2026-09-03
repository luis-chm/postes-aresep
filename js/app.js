// Coordenadas de referencia CRTM05, usadas únicamente para el indicador
// informativo de posición del cursor (no para los datos de postes).
proj4.defs("EPSG:5367", "+proj=tmerc +lat_0=0 +lon_0=-84 +k=0.9999 +x_0=500000 +y_0=0 +ellps=WGS84 +units=m +no_defs");

const OP_COLORS = {
  ICE: '#f5c518', CNFL: '#e8833a', COOPELESCA: '#4caf6d',
  COOPEGUANACASTE: '#1fb6a8', JASEC: '#4c8df5', COOPESANTOS: '#7fd1e0',
  ESPH: '#a76cf2', COOPEALFARORUIZ: '#e15fb0', 'ZONA EN BLANCO': '#555555'
};
function colorFor(op){
  if(OP_COLORS[op]) return OP_COLORS[op];
  // algunos datasets de ARESEP usan variantes del nombre (ej. "COOPEGUANACASTE R.L."
  // en vez de "COOPEGUANACASTE") — probamos coincidencia por prefijo antes de
  // caer al color aleatorio por hash.
  const key = Object.keys(OP_COLORS).find(k => op.startsWith(k));
  if(key) return OP_COLORS[key];
  let h=0; for(const c of op) h=(h*31+c.charCodeAt(0))%360;
  return `hsl(${h},65%,60%)`;
}

const map = L.map('map',{zoomControl:false}).setView([9.75,-84.0],8);

const streetLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'© OpenStreetMap contributors', maxZoom:19
});

// Vista satelital: imágenes de Esri (gratis, sin API key) + una capa de
// referencia con nombres de calles/lugares encima, para que siga siendo
// legible. Es la combinación estándar que usan la mayoría de mapas
// satelitales (Google Maps, etc. hacen lo mismo con sus propias capas).
const satelliteImagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution:'Tiles © Esri — Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community', maxZoom:19 }
);
const satelliteLabels = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom:19 }
);
const satelliteLayer = L.layerGroup([satelliteImagery, satelliteLabels]);

streetLayer.addTo(map);
L.control.layers(
  { 'Calle': streetLayer, 'Satélite': satelliteLayer },
  null,
  { position:'bottomright' }
).addTo(map);
L.control.zoom({position:'bottomright'}).addTo(map);

// El filtro oscuro (invert/hue-rotate en CSS) está pensado para las
// calles de OpenStreetMap, que solo vienen en colores claros. No tiene
// sentido aplicárselo a la foto satelital — se ve con colores raros.
// Esta clase le dice al CSS cuándo desactivar ese filtro.
map.on('baselayerchange', e=>{
  document.getElementById('map').classList.toggle('satellite-active', e.name === 'Satélite');
});

map.on('mousemove', e=>{
  document.getElementById('wgsVal').textContent = e.latlng.lat.toFixed(5)+', '+e.latlng.lng.toFixed(5);
  try{
    const [x,y] = proj4('WGS84','EPSG:5367',[e.latlng.lng, e.latlng.lat]);
    document.getElementById('crtmVal').textContent = x.toFixed(1)+', '+y.toFixed(1);
  }catch(err){}
});

const input = document.getElementById('districtInput');
const btn = document.getElementById('searchBtn');
const statusText = document.getElementById('statusSummary');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');

function showState(state){
  emptyEl.style.display = state==='empty' ? 'flex':'none';
  errorEl.style.display = state==='error' ? 'flex':'none';
}
showState('empty');

function tryParseCoords(str){
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if(!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2])];
}

// Quita tildes (á→a, é→e, etc.) pero preserva la ñ/Ñ, que es una letra
// aparte del español, no una vocal acentuada. Esto es SOLO para uso
// interno (claves de districtBatches, sincronizar el árbol, filtro de
// búsqueda) — para que "guacima" y "GUÁCIMA" se traten como lo mismo.
// NUNCA se usa para armar la consulta a la API: ARESEP guarda los
// nombres de distrito CON tildes tal como corresponde ortográficamente
// (ej. "GUÁCIMA", "SAN JOSÉ", "CONCEPCIÓN"), así que la consulta necesita
// el nombre oficial completo, tildes incluidas — ver OFFICIAL_NAME_BY_KEY
// más abajo.
const ACCENT_MAP = {
  'Á':'A','À':'A','Ä':'A','Â':'A',
  'É':'E','È':'E','Ë':'E','Ê':'E',
  'Í':'I','Ì':'I','Ï':'I','Î':'I',
  'Ó':'O','Ò':'O','Ö':'O','Ô':'O',
  'Ú':'U','Ù':'U','Ü':'U','Û':'U'
};
function normalizeDistrict(name){
  return name.toUpperCase().split('').map(c => ACCENT_MAP[c] || c).join('').trim();
}

// Traduce una clave sin tildes (ej. "GUACIMA") al nombre oficial con
// tildes (ej. "Guácima"), usando el árbol de distritos como fuente de
// verdad. Se llena en init() apenas se carga DIVISION_TREE.
const OFFICIAL_NAME_BY_KEY = {};
function buildOfficialNameIndex(){
  for(const prov in DIVISION_TREE){
    for(const canton in DIVISION_TREE[prov]){
      for(const dist of DIVISION_TREE[prov][canton]){
        OFFICIAL_NAME_BY_KEY[normalizeDistrict(dist)] = dist;
      }
    }
  }
}

// Se carga de forma asíncrona en init() desde data/division-tree.json,
// solo para poblar el árbol de checkboxes. Ya no hace falta para la
// búsqueda por coordenadas (ver más abajo).
let DIVISION_TREE = {};

// --- Servicio ArcGIS REST de ARESEP ---
// Es el mismo backend geoespacial que usa el buscador oficial de ARESEP.
// A diferencia del endpoint .svc viejo: permite CORS directo desde el
// navegador (sin proxy), devuelve coordenadas ya en WGS84 (sin necesitar
// proj4 para los datos) y soporta consultas por distancia a un punto, lo
// que evita tener que adivinar en qué distrito cae una coordenada.
const ARESEP_QUERY_URL = 'https://mapas.aresep.go.cr/server/rest/services/I_Energia_Externo_PII/I_Energia_Externo_Post_Transf_PII/MapServer/0/query';
// Zonas de concesión por operador eléctrico — mismo servidor de ARESEP,
// capa de polígonos (id=2) en vez de postes. También publicada en 2019 y
// nunca actualizada desde entonces, igual que los postes.
const CONCESSION_QUERY_URL = 'https://mapas.aresep.go.cr/server/rest/services/I_Energia_Externo_PII/I_Energia_Externo_PII/MapServer/2/query';
const PAGE_SIZE = 1500; // límite del servicio (MaxRecordCount)
const MAX_PAGES = 40;   // salvaguarda (60,000 postes como máximo por consulta)

// Respaldo: tu propio proxy en Cloudflare Workers. El acceso directo ya
// funciona (CORS lo permite), así que este solo se usa si la petición
// directa falla — por un bloqueo temporal del firewall de ARESEP, un
// cambio futuro en su política CORS, o una caída puntual del servicio.
const MY_WORKER = 'https://postes-aresep-proxy.luischavesmora.workers.dev/';

async function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  try{
    return await fetch(url, {signal: ctrl.signal});
  }finally{
    clearTimeout(t);
  }
}

// Intenta la petición directa; si falla por cualquier motivo (red, CORS,
// bloqueo del WAF, respuesta que no es JSON válido), reintenta a través
// del proxy propio antes de darse por vencido.
async function fetchArcgisJson(url){
  try{
    const res = await fetchWithTimeout(url, 15000);
    if(!res.ok) throw new Error('HTTP '+res.status);
    return await res.json(); // si el WAF devolvió HTML, esto lanza y cae al catch
  }catch(directErr){
    const proxied = MY_WORKER + '?url=' + encodeURIComponent(url);
    const res = await fetchWithTimeout(proxied, 15000);
    if(!res.ok) throw directErr;
    return await res.json();
  }
}

// --- Zonas de concesión por operador (overlay de polígonos) ---
// Se carga una sola vez (son pocas decenas de polígonos, cabe en una
// consulta) y se agrega/quita del mapa con el checkbox correspondiente.
let concessionLayer = null;

async function toggleConcessionZones(show){
  if(!show){
    if(concessionLayer) map.removeLayer(concessionLayer);
    return;
  }
  if(concessionLayer){
    concessionLayer.addTo(map);
    concessionLayer.bringToBack();
    return;
  }
  const params = new URLSearchParams({
    f: 'geojson',
    outFields: 'OPERADOR,DESCRIPCION,AREAKM',
    outSR: '4326',
    where: '1=1',
    resultRecordCount: '2000'
  });
  const url = CONCESSION_QUERY_URL + '?' + params.toString();
  try{
    const gj = await fetchArcgisJson(url);
    if(gj.error) throw new Error(gj.error.message || 'Error de la API de ARESEP');
    concessionLayer = L.geoJSON(gj, {
      style: feature => ({
        color: '#666',
        weight: 1,
        fillColor: colorFor(feature.properties.OPERADOR || ''),
        fillOpacity: 0.22
      }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const area = p.AREAKM ? Math.round(p.AREAKM).toLocaleString('es-CR')+' km²' : '';
        layer.bindPopup(
          `<div class="popup-op">${p.OPERADOR || 'Sin operador'}</div>`+
          `<div class="popup-loc">${p.DESCRIPCION || ''}${area ? ' · '+area : ''}</div>`
        );
      }
    }).addTo(map);
    concessionLayer.bringToBack();
  }catch(err){
    document.getElementById('concessionToggle').checked = false;
    statusText.textContent = 'No se pudieron cargar las zonas de concesión.';
  }
}


// servicio corta la respuesta (exceededTransferLimit).
async function arcgisQueryAll(extraParams, onProgress){
  const rows = [];
  let offset = 0;
  for(let page=0; page<MAX_PAGES; page++){
    const params = new URLSearchParams({
      f: 'geojson',
      outFields: 'Operador,nom_cant,nom_prov,nom_distr,cod_dta',
      outSR: '4326',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      ...extraParams
    });
    const url = ARESEP_QUERY_URL + '?' + params.toString();
    if(page===0) document.getElementById('rawLink').href = url;
    if(onProgress) onProgress(rows.length);

    const gj = await fetchArcgisJson(url);
    if(gj.error) throw new Error(gj.error.message || 'Error de la API de ARESEP');

    const feats = gj.features || [];
    for(const f of feats){
      const coords = f.geometry && f.geometry.coordinates;
      if(!coords) continue;
      rows.push({
        operador: f.properties.Operador || 'N/D',
        distrito: f.properties.nom_distr || '',
        canton: f.properties.nom_cant || '',
        provincia: f.properties.nom_prov || '',
        lon: coords[0], lat: coords[1]
      });
    }

    const exceeded = gj.exceededTransferLimit || (gj.properties && gj.properties.exceededTransferLimit);
    if(!exceeded || feats.length===0) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

// --- Estado: un "lote" por consulta cargada (distrito o punto por
// coordenada). Permite cargar/quitar cada uno de forma independiente,
// sin perder los demás que estén en el mapa. ---
const districtBatches = {}; // key -> {label, rows, markers}
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
    if(typeof r.lat!=='number' || typeof r.lon!=='number') continue;
    const op = r.operador || 'N/D';
    const marker = L.circleMarker([r.lat,r.lon],{
      radius:5, weight:1, color:'#0d1116', fillColor:colorFor(op), fillOpacity:.9
    }).bindPopup(
      `<div class="popup-op">${op}</div><div class="popup-loc">${r.distrito}, ${r.canton}, ${r.provincia}</div>`
    );
    marker._op = op;
    if(isOperatorEnabled(op)) marker.addTo(map);
    markers.push(marker);
    bounds.push([r.lat,r.lon]);
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
  const batches = Object.entries(districtBatches);
  const total = batches.reduce((s,[,b])=>s+b.rows.length,0);
  const n = batches.length;

  statusText.textContent = n ? (total.toLocaleString('es-CR') + ' postes · ' + n + (n===1?' distrito':' distritos')) : '';

  const chipsEl = document.getElementById('loadedChips');
  chipsEl.innerHTML = '';
  if(n){
    const label = document.createElement('span');
    label.className = 'dp-loaded-label';
    label.textContent = 'Cargados';
    chipsEl.appendChild(label);
    for(const [key, batch] of batches){
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span>${batch.label}</span>`;
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.title = 'Quitar '+batch.label;
      closeBtn.addEventListener('click', ()=>unloadDistrict(key));
      chip.appendChild(closeBtn);
      chipsEl.appendChild(chip);
    }
  }
  chipsEl.style.display = n ? 'flex' : 'none';

  const badge = document.getElementById('districtBadge');
  badge.textContent = n;
  badge.style.display = n ? 'flex' : 'none';
}

function setTreeChecked(key, checked){
  document.querySelectorAll('.dp-distrito-row[data-key="'+CSS.escape(key)+'"]').forEach(row=>{
    row.querySelector('input').checked = checked;
    row.classList.toggle('active', checked);
  });
}

// Carga (si no está ya cargado) los postes de un distrito por nombre.
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

  statusText.textContent = 'Consultando '+(opts.label||distName)+'...';
  showState(null);
  try{
    // Para la consulta hay que usar el nombre CON tildes tal como lo
    // tiene la base de datos de ARESEP. Si conocemos el nombre oficial
    // (por el árbol de distritos), lo usamos aunque el usuario haya
    // escrito sin tildes; si no lo conocemos, usamos tal cual se escribió.
    const queryValue = (OFFICIAL_NAME_BY_KEY[key] || distName).toUpperCase();
    const safeName = queryValue.replace(/'/g, "''"); // por si algún nombre trajera comillas
    const rows = await arcgisQueryAll(
      { where: `nom_distr='${safeName}'` },
      (n)=>{ if(n) statusText.textContent = 'Consultando '+(opts.label||distName)+'... ('+n+' postes)'; }
    );
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

// --- Búsqueda por coordenada: ubica el distrito real donde cae el punto
// (usando el mismo servicio de ARESEP como referencia geográfica: el
// distrito del poste más cercano) y carga TODO ese distrito — igual que
// si lo hubieras escrito a mano o marcado en el árbol. ---

function haversineMeters(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = d => d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

// Consulta liviana (sin paginar) para encontrar postes cercanos y así
// identificar el distrito/cantón/provincia real del punto. Va ampliando
// el radio de búsqueda hasta encontrar algo (para zonas con pocos postes).
async function findDistrictNear(lat, lon){
  const radii = [500, 2000, 5000, 15000];
  for(const r of radii){
    const params = new URLSearchParams({
      f: 'geojson',
      outFields: 'nom_distr,nom_cant,nom_prov',
      outSR: '4326',
      resultRecordCount: '50',
      geometry: lon+','+lat,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      distance: String(r),
      units: 'esriSRUnit_Meter',
      spatialRel: 'esriSpatialRelIntersects'
    });
    const url = ARESEP_QUERY_URL + '?' + params.toString();
    const gj = await fetchArcgisJson(url);
    if(gj.error) throw new Error(gj.error.message || 'Error de la API de ARESEP');
    const feats = gj.features || [];
    if(!feats.length) continue;

    let best=null, bestD=Infinity;
    for(const f of feats){
      const c = f.geometry && f.geometry.coordinates;
      if(!c) continue;
      const d = haversineMeters(lat, lon, c[1], c[0]);
      if(d<bestD){ bestD=d; best=f.properties; }
    }
    if(best){
      return { distrito: best.nom_distr, canton: best.nom_cant, provincia: best.nom_prov, distanceM: bestD };
    }
  }
  return null;
}

let searchMarker = null;
async function goToCoords(lat, lon){
  if(searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.circleMarker([lat,lon], {
    radius:9, weight:2, color:'#fff', fillColor:'#f5c518', fillOpacity:1
  }).addTo(map).bindPopup(
    `<div class="popup-op">Coordenada buscada</div>`+
    `<div class="popup-loc">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`
  ).openPopup();
  map.setView([lat,lon], 14);
  showState(null);

  statusText.textContent = 'Ubicando distrito...';
  let match;
  try{
    match = await findDistrictNear(lat, lon);
  }catch(err){
    statusText.textContent = 'No se pudo ubicar el distrito de este punto.';
    return;
  }

  if(!match){
    statusText.textContent = 'Ubicación: '+lat.toFixed(5)+', '+lon.toFixed(5)+' (no hay postes registrados cerca)';
    return;
  }

  const label = `${match.distrito} (${match.canton})`;
  if(!document.getElementById('accumulate').checked) clearAllDistricts();

  statusText.textContent = 'Cargando distrito '+label+'...';
  const result = await loadDistrict(match.distrito, {label});
  if(result==='empty'){
    statusText.textContent = 'Ubicación: '+label+' (sin postes registrados con ese nombre)';
  }else if(result==='error'){
    statusText.textContent = 'No se pudieron cargar los postes de '+label;
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
      'El servicio de ARESEP no respondió. Probá de nuevo en un momento.';
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

document.getElementById('concessionToggle').addEventListener('change', e=>{
  toggleConcessionZones(e.target.checked);
});

document.querySelectorAll('.state-close').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.getElementById(btn.dataset.target).style.display = 'none';
  });
});

const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', ()=>{
  const light = document.body.classList.toggle('light');
  themeBtn.textContent = light ? '☀ Claro' : '☾ Oscuro';
});

// --- Inicialización: solo carga el árbol de nombres de distrito (7KB),
// ya no hace falta el archivo de polígonos. ---
async function init(){
  btn.disabled = true;
  statusText.textContent = 'Cargando lista de distritos...';
  try{
    const res = await fetch('data/division-tree.json');
    if(!res.ok) throw new Error('HTTP error');
    DIVISION_TREE = await res.json();
    buildOfficialNameIndex();
    buildDistrictTree();
    statusText.textContent = '';
  }catch(err){
    statusText.textContent = 'No se pudo cargar data/division-tree.json. El árbol de distritos no estará disponible; la búsqueda por texto y por coordenadas sigue funcionando.';
  }
  btn.disabled = false;
}
init();
