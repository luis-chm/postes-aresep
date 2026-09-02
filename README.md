[README.md](https://github.com/user-attachments/files/31760250/README.md)
# Postes · ARESEP

Visor de postes eléctricos de Costa Rica, con datos abiertos directos de ARESEP (Autoridad Reguladora de los Servicios Públicos). Permite ubicar los postes por distrito, por coordenada, o navegando un árbol de provincia → cantón → distrito, sin pasar por el visor oficial.

**Sitio en vivo:** https://luis-chm.github.io/postes-aresep/

## Qué hace

- **Buscar por distrito**: escribís el nombre (con o sin tildes, ARESEP resuelve el nombre oficial exacto internamente) y carga todos sus postes en el mapa.
- **Buscar por coordenadas**: pegás un par lat, lon y la app ubica automáticamente el distrito real donde cae ese punto (usando el poste más cercano como referencia) y carga todo el distrito — no solo lo que esté cerca.
- **Árbol de distritos**: un panel plegable por provincia → cantón → distrito con checkbox, para explorar sin necesidad de saber el nombre exacto de antemano. Se puede filtrar por texto.
- **Múltiples distritos a la vez**: con "agregar al mapa" activado, podés ir sumando distritos; cada uno se puede quitar individualmente desde los chips ("ver todos") o desmarcando su checkbox en el árbol.
- **Filtro por operador**: leyenda con cada empresa eléctrica (ICE, CNFL, cooperativas, etc.), cada una se puede ocultar/mostrar sin perder los demás.
- **Vista calle / satélite**: capas base intercambiables (OpenStreetMap y Esri World Imagery con nombres de lugares superpuestos).
- **Tema claro / oscuro**.
- Indicador de coordenadas en tiempo real (WGS84 y CRTM05, el sistema de referencia oficial de Costa Rica) al mover el mouse sobre el mapa.

## Cómo obtiene los datos

La fuente es el servicio geoespacial público de ARESEP (ArcGIS REST), la misma capa que usa su propio buscador oficial de datos abiertos:

```
https://mapas.aresep.go.cr/server/rest/services/I_Energia_Externo_PII/I_Energia_Externo_Post_Transf_PII/MapServer/0/query
```

Las consultas se hacen directo desde el navegador (el servicio permite CORS), pidiendo las coordenadas ya en WGS84 para no tener que convertir manualmente desde el sistema CRTM05 nativo de los datos.

**Respaldo automático:** si la consulta directa falla por cualquier motivo (firewall de ARESEP, caída puntual del servicio, cambio futuro de política CORS), la app reintenta automáticamente a través de un proxy propio en Cloudflare Workers, sin que el usuario note nada más que un pequeño retraso.

### El árbol de distritos (`data/division-tree.json`)

La lista completa de provincia/cantón/distrito se construyó a partir de un extracto real de los postes de ARESEP (no de una lista genérica de división territorial), para garantizar que los nombres usados coincidan exactamente con lo que la base de datos de ARESEP espera — incluyendo casos particulares como distritos con "ñ", con tildes, o con nombres que difieren ligeramente del nombre oficial INEC (ej. el distrito "Carmen" de San José aparece internamente en ARESEP como "El Carmen").

## Estructura del proyecto

```
postes-aresep/
├── index.html              estructura de la página
├── css/
│   └── style.css           estilos (tema claro/oscuro incluido)
├── js/
│   └── app.js               toda la lógica: mapa, consultas, árbol de distritos
├── data/
│   └── division-tree.json   árbol provincia → cantón → distrito
└── img/
    ├── favicon.svg
    └── favicon.ico
```

## Tecnologías

- [Leaflet](https://leafletjs.com/) — mapa interactivo
- [proj4js](http://proj4js.org/) — conversión de coordenadas WGS84 ↔ CRTM05 (solo para el indicador informativo, no para los datos de postes)
- Capas base: [OpenStreetMap](https://www.openstreetmap.org/) y [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
- Sin build ni dependencias de servidor — HTML/CSS/JS planos, servido como sitio estático en GitHub Pages
- [Cloudflare Workers](https://workers.cloudflare.com/) — proxy propio de respaldo (ver `worker.js`, se despliega por separado en Cloudflare, no en GitHub Pages)

## Desplegar cambios

El sitio se sirve por GitHub Pages directo desde este repositorio. Al modificar `js/app.js` o `css/style.css`, hay que subir también el número de versión en los `<link>`/`<script>` de `index.html` (ej. `style.css?v=3`, `app.js?v=8`) — si no, el navegador puede seguir sirviendo una copia vieja cacheada del archivo.

## Limitaciones conocidas

- La búsqueda por nombre de distrito depende de coincidencia exacta con el campo `nom_distr` de ARESEP. Nombres de distrito duplicados en distintos cantones (ej. "San Antonio", que existe en 9 cantones distintos) devuelven los postes de todos ellos combinados — es una limitación del servicio de ARESEP, no de esta app.
- Los datos reflejan el último registro público de ARESEP; no se actualizan en tiempo real.
- El proxy de Cloudflare Workers es de respaldo personal, sujeto a los límites del plan gratuito (100,000 peticiones/día, de sobra para este uso).

## Créditos

Datos: [ARESEP](https://aresep.go.cr/) · Mapas base: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, © [Esri](https://www.esri.com/)
