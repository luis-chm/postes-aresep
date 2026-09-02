// Coordenadas de referencia CRTM05, usadas únicamente para el indicador
// informativo de posición del cursor (no para los datos de postes).
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

function tryParseCoords(str){
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if(!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2])];
}

function normalizeDistrict(name){
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
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

// Trae TODAS las filas de una consulta, paginando automáticamente si el
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
    const safeName = key.replace(/'/g, "''"); // por si algún nombre trajera comillas
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

// --- Búsqueda por coordenada: ya no hace falta adivinar el distrito.
// Se le pide directo al servicio "todos los postes a X metros de este
// punto" — es más simple, más rápido, y más preciso (no depende de
// límites administrativos ni de geocodificación de terceros). ---
const COORD_SEARCH_RADIUS_M = 500;

let searchMarker = null;
async function goToCoords(lat, lon){
  if(searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.circleMarker([lat,lon], {
    radius:9, weight:2, color:'#fff', fillColor:'#f5c518', fillOpacity:1
  }).addTo(map).bindPopup(
    `<div class="popup-op">Coordenada buscada</div>`+
    `<div class="popup-loc">${lat.toFixed(5)}, ${lon.toFixed(5)}<br>Radio: ${COORD_SEARCH_RADIUS_M} m</div>`
  ).openPopup();
  map.setView([lat,lon], 16);
  showState(null);

  const key = 'COORD:'+lat.toFixed(5)+','+lon.toFixed(5);
  if(districtBatches[key]) return; // ya está cargado este mismo punto

  if(!document.getElementById('accumulate').checked) clearAllDistricts();

  statusText.textContent = 'Buscando postes cerca de este punto...';
  try{
    const rows = await arcgisQueryAll({
      geometry: lon+','+lat,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      distance: String(COORD_SEARCH_RADIUS_M),
      units: 'esriSRUnit_Meter',
      spatialRel: 'esriSpatialRelIntersects'
    });

    if(!rows.length){
      statusText.textContent = 'Sin postes registrados a menos de '+COORD_SEARCH_RADIUS_M+' m de este punto.';
      return;
    }

    // Etiqueta amigable: el distrito más frecuente entre los resultados
    const freq = {};
    for(const r of rows) freq[r.distrito] = (freq[r.distrito]||0)+1;
    const topDist = Object.keys(freq).sort((a,b)=>freq[b]-freq[a])[0];
    const sample = rows.find(r=>r.distrito===topDist);
    const label = `${topDist}${sample.canton ? ' ('+sample.canton+')' : ''} — cerca de ${lat.toFixed(4)}, ${lon.toFixed(4)}`;

    const {markers, bounds} = renderBatch(rows);
    districtBatches[key] = {label, rows, markers};
    rebuildLegend();
    refreshStatus();
    if(bounds.length) map.fitBounds(bounds, {padding:[40,40]});
  }catch(err){
    statusText.textContent = 'No se pudieron cargar los postes cerca de este punto.';
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
    buildDistrictTree();
    statusText.textContent = '';
  }catch(err){
    statusText.textContent = 'No se pudo cargar data/division-tree.json. El árbol de distritos no estará disponible; la búsqueda por texto y por coordenadas sigue funcionando.';
  }
  btn.disabled = false;
}
init();
