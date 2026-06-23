// Action Mark — Dashboard collegata al server vero
const API_BASE = window.location.origin;
const WS_BASE = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');

let token = localStorage.getItem('am_token') || null;
let clubName = localStorage.getItem('am_club') || '';
let role = localStorage.getItem('am_role') || 'club';
let BUOYS = [];
let selectedId = null;
let fbTimer = null;
let map, markers = {}, wpMode = false, waypoints = [], wpMarkers = [], wpLine = null;
let dashWs = null;

const MODE_COLORS = {LOITER:'#1565c0', MANUAL:'#2e7d32', HOLD:'#e65100', RTL:'#3949ab', OFFLINE:'#546e7a', AUTO:'#3949ab', GUIDED:'#3949ab', STEERING:'#546e7a', ACRO:'#546e7a'};

// ── LOGIN ──
function doLogin(){
  const email = document.getElementById('lemail').value;
  const pwd = document.getElementById('lpwd').value;
  fetch(API_BASE + '/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: email, password: pwd})
  }).then(r => {
    if(!r.ok) throw new Error('credenziali errate');
    return r.json();
  }).then(data => {
    token = data.token;
    clubName = data.club_name;
    role = data.role;
    localStorage.setItem('am_token', token);
    localStorage.setItem('am_club', clubName);
    localStorage.setItem('am_role', role);
    document.getElementById('login-error').classList.remove('show');
    document.getElementById('login').classList.add('hidden');
    document.getElementById('app').classList.add('show');
    setTimeout(initApp, 100);
  }).catch(() => {
    document.getElementById('login-error').classList.add('show');
  });
}
function doLogout(){
  localStorage.removeItem('am_token');
  localStorage.removeItem('am_club');
  localStorage.removeItem('am_role');
  token = null;
  if(dashWs) dashWs.close();
  document.getElementById('app').classList.remove('show');
  document.getElementById('login').classList.remove('hidden');
}
document.getElementById('lpwd').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });

window.addEventListener('load', () => {
  if(token){
    document.getElementById('login').classList.add('hidden');
    document.getElementById('app').classList.add('show');
    setTimeout(initApp, 100);
  }
});

function authHeaders(){
  return {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'};
}

// ── INIT ──
function initApp(){
  const initials = (clubName || 'CL').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('tb-avatar').textContent = initials;
  document.getElementById('tb-clubname').textContent = clubName + (role === 'admin' ? ' (Admin)' : '');
  document.getElementById('club-av').textContent = initials;
  document.getElementById('club-name-footer').textContent = clubName;
  document.getElementById('club-plan').textContent = role === 'admin' ? 'Amministratore' : 'Piano Free';

  if(role === 'admin'){
    document.getElementById('admin-clubs-btn').style.display = 'flex';
    document.getElementById('addbuoy-club-group').style.display = 'block';
  }

  initMap();
  caricaBoe();
  connettiWebSocket();
  addLog('Connessione al server in corso...', 'warn');
}

// ── GESTIONE CLUB (solo admin) ──
function openManageClubs(){
  document.getElementById('new-club-name').value = '';
  document.getElementById('new-club-email').value = '';
  document.getElementById('new-club-pwd').value = '';
  document.getElementById('club-create-msg').style.display = 'none';
  caricaClubs();
  openModal('modal-clubs');
}

function caricaClubs(){
  fetch(API_BASE + '/api/clubs', {headers: authHeaders()})
    .then(r => r.json())
    .then(list => {
      const container = document.getElementById('clubs-list');
      const select = document.getElementById('new-buoy-club');
      if(list.length === 0){
        container.innerHTML = '<div style="font-size:12px;color:var(--grey);text-align:center;padding:12px">Nessun club ancora creato</div>';
      } else {
        container.innerHTML = list.map(c =>
          '<div style="display:flex;align-items:center;gap:10px;background:var(--bg);border-radius:8px;padding:10px 12px">' +
          '<div style="width:30px;height:30px;border-radius:8px;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">' + c.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() + '</div>' +
          '<div style="flex:1"><div style="font-size:13px;font-weight:700;color:var(--text)">' + c.name + '</div><div style="font-size:11px;color:var(--grey)">' + c.email + '</div></div>' +
          '</div>'
        ).join('');
      }
      if(select){
        select.innerHTML = '<option value="">Nessun club (boa Action Mark)</option>' +
          list.map(c => '<option value="'+c.id+'">'+c.name+'</option>').join('');
      }
    });
}

function createClub(){
  const name = document.getElementById('new-club-name').value;
  const email = document.getElementById('new-club-email').value;
  const pwd = document.getElementById('new-club-pwd').value;
  const msg = document.getElementById('club-create-msg');
  if(!name || !email || !pwd){
    msg.style.display = 'block';
    msg.style.background = 'var(--red-bg)'; msg.style.color = 'var(--red)';
    msg.textContent = 'Compila tutti i campi';
    return;
  }
  fetch(API_BASE + '/api/clubs', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({name: name, email: email, password: pwd})
  }).then(r => r.json().then(data => ({ok: r.ok, data: data}))).then(({ok, data}) => {
    msg.style.display = 'block';
    if(ok){
      msg.style.background = 'var(--grn-bg)'; msg.style.color = 'var(--green)';
      msg.textContent = 'Club "' + name + '" creato con successo';
      document.getElementById('new-club-name').value = '';
      document.getElementById('new-club-email').value = '';
      document.getElementById('new-club-pwd').value = '';
      caricaClubs();
      addLog('Nuovo club registrato: ' + name, 'ok');
    } else {
      msg.style.background = 'var(--red-bg)'; msg.style.color = 'var(--red)';
      msg.textContent = data.detail || 'Errore nella creazione';
    }
  });
}

function caricaBoe(){
  fetch(API_BASE + '/api/buoys', {headers: authHeaders()})
    .then(r => {
      if(r.status === 401){ doLogout(); return []; }
      return r.json();
    })
    .then(list => {
      BUOYS = list.map(b => {
        const t = b.telemetry || {};
        return {
          id: b.id, name: b.name, clubName: b.club_name || clubName,
          mode: t.modo || 'OFFLINE',
          volt: t.voltaggio || 0,
          sat: t.satelliti || 0,
          lat: t.lat || null, lon: t.lon || null,
          armed: !!t.armato,
          calibrazione: !!t.calibrazione,
          online: b.online,
          lastSeen: b.online ? Date.now() : null,
        };
      });
      renderSidebar();
      renderMarkers();
      updateStatsBar();
      if(BUOYS.length > 0) selectBuoy(BUOYS[0].id);
      addLog('Caricate ' + BUOYS.length + ' boe del club', 'ok');
    });
}

// ── WEBSOCKET DASHBOARD ──
function connettiWebSocket(){
  dashWs = new WebSocket(WS_BASE + '/dashboard/ws?token=' + token);
  dashWs.onopen = () => {
    document.getElementById('conn-dot').classList.remove('off');
    addLog('Connesso al server in tempo reale', 'ok');
  };
  dashWs.onclose = () => {
    document.getElementById('conn-dot').classList.add('off');
    addLog('Connessione persa — riprovo in 5s', 'err');
    setTimeout(connettiWebSocket, 5000);
  };
  dashWs.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if(data.type === 'telemetry') aggiornaTelemetria(data);
    else if(data.type === 'status') aggiornaStatus(data);
  };
}

function aggiornaTelemetria(data){
  const b = BUOYS.find(x => x.id === data.buoy_id);
  if(!b) return;
  const modoVecchio = b.mode;
  b.mode = data.modo || b.mode;
  b.volt = data.voltaggio || 0;
  b.sat = data.satelliti || 0;
  b.lat = data.lat || b.lat;
  b.lon = data.lon || b.lon;
  b.armed = !!data.armato;
  b.calibrazione = !!data.calibrazione;
  b.online = true;
  b.lastSeen = Date.now();
  if(selectedId === b.id && document.getElementById('modal-bussola').classList.contains('show')){
    calibrazioneInCorso = b.calibrazione;
    aggiornaUiCalibrazione();
  }

  if(modoVecchio !== b.mode){
    waypoints.forEach(w => {
      if(w.buoyId === b.id && w.status === 'going' && b.mode === 'LOITER'){
        w.status = 'fixed';
        renderWpTable();
        addLog(b.name + ' in posizione — FIX attivo', 'ok');
      }
    });
  }

  renderSidebar();
  updateMarker(b);
  if(selectedId === b.id) updatePanel(b);
  updateStatsBar();
}

function aggiornaStatus(data){
  const b = BUOYS.find(x => x.id === data.buoy_id);
  if(!b) return;
  b.online = data.online;
  if(!b.online) b.mode = 'OFFLINE';
  renderSidebar();
  updateMarker(b);
  if(selectedId === b.id) updatePanel(b);
  updateStatsBar();
  addLog(b.name + (b.online ? ' connessa' : ' disconnessa'), b.online ? 'ok' : 'warn');
}

// ── MAP ──
function initMap(){
  map = L.map('map', {zoomControl: true}).setView([45.65, 10.65], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: '© OpenStreetMap', maxZoom: 18}).addTo(map);
  map.on('click', onMapClick);
}
function makeBuoyIcon(b){
  const c = MODE_COLORS[b.mode] || '#546e7a';
  return L.divIcon({
    html: '<div style="width:16px;height:16px;border-radius:50%;background:' + c + ';border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.25);' + (!b.online ? 'opacity:.4' : '') + '"></div>',
    className: '', iconSize: [16,16], iconAnchor: [8,8]
  });
}
function renderMarkers(){
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  BUOYS.forEach(b => {
    if(!b.lat || !b.lon) return;
    const m = L.marker([b.lat, b.lon], {icon: makeBuoyIcon(b)}).addTo(map);
    m.bindPopup('<div class="lf-popup"><div class="lf-popup-name">' + b.name + '</div><div class="lf-popup-row"><span>Modalità</span><strong>' + b.mode + '</strong></div><div class="lf-popup-row"><span>Batteria</span><strong>' + (b.volt>0?b.volt.toFixed(1)+'V':'N/D') + '</strong></div><button class="lf-popup-btn" onclick="selectBuoy(' + b.id + ');map.closePopup()">Seleziona e controlla</button></div>');
    m.on('click', () => selectBuoy(b.id));
    markers[b.id] = m;
  });
}
function updateMarker(b){
  if(markers[b.id] && b.lat && b.lon){
    markers[b.id].setIcon(makeBuoyIcon(b));
    markers[b.id].setLatLng([b.lat, b.lon]);
  } else if(!markers[b.id] && b.lat && b.lon){
    const m = L.marker([b.lat, b.lon], {icon: makeBuoyIcon(b)}).addTo(map);
    m.on('click', () => selectBuoy(b.id));
    markers[b.id] = m;
  }
}

// ── PERCORSO REGATA ──
function toggleWaypointMode(){
  wpMode = !wpMode;
  const btn = document.getElementById('wp-toggle-btn');
  const modeBtn = document.getElementById('wp-mode-btn');
  if(wpMode){
    map.getContainer().style.cursor = 'crosshair';
    btn.classList.add('active');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Fine';
    modeBtn.classList.add('active');
    modeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Fine aggiunta';
    document.getElementById('wp-label').style.display = 'flex';
    switchTab('wp', document.querySelectorAll('.bp-tab')[1]);
  } else {
    map.getContainer().style.cursor = '';
    btn.classList.remove('active');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Percorso';
    modeBtn.classList.remove('active');
    modeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Aggiungi posizione';
    document.getElementById('wp-label').style.display = 'none';
  }
}

function distanzaMetri(a, b){
  const dlat = (b.lat-a.lat)*111000;
  const dlon = (b.lon-a.lon)*111000*Math.cos(a.lat*Math.PI/180);
  return Math.sqrt(dlat*dlat+dlon*dlon);
}

function creaMarkerWaypoint(w){
  const icon = L.divIcon({
    html: '<div style="background:#e65100;color:white;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.25);margin-left:-13px;margin-top:-13px;cursor:grab">' + w.n + '</div>',
    className: '', iconSize: [26,26], iconAnchor: [13,13]
  });
  const m = L.marker([w.lat, w.lon], {icon: icon, draggable: true}).addTo(map);
  m.bindPopup('<b>Posizione ' + w.n + '</b><br>' + w.lat.toFixed(5) + '°N · ' + w.lon.toFixed(5) + '°E<br><small>Tieni premuto e sposta per modificare</small>');
  m.on('dragend', (ev) => {
    const pos = ev.target.getLatLng();
    w.lat = pos.lat; w.lon = pos.lng;
    updateCourseLine();
    renderWpTable();
    addLog('Posizione ' + w.n + ' spostata', 'ok');
  });
  return m;
}

function onMapClick(e){
  if(!wpMode) return;
  const n = waypoints.length + 1;
  const w = {n: n, lat: e.latlng.lat, lon: e.latlng.lng, buoyId: null, status: 'idle'};
  waypoints.push(w);
  wpMarkers.push(creaMarkerWaypoint(w));
  updateCourseLine();
  renderWpTable();
  document.getElementById('st-wp').textContent = waypoints.length;
  document.getElementById('wp-count-tab').textContent = waypoints.length;
  addLog('Posizione ' + n + ' aggiunta al percorso', 'ok');
}

function updateCourseLine(){
  if(wpLine) map.removeLayer(wpLine);
  if(waypoints.length < 2) return;
  const pts = waypoints.map(w => [w.lat, w.lon]);
  wpLine = L.polyline([...pts, pts[0]], {color: '#e65100', weight: 2.5, dashArray: '8,6', opacity: .85}).addTo(map);
}

function renderWpTable(){
  const tbody = document.getElementById('wp-tbody');
  tbody.innerHTML = '';
  const empty = waypoints.length === 0;
  document.getElementById('wp-empty').style.display = empty ? 'block' : 'none';
  document.getElementById('wp-table').style.display = empty ? 'none' : 'table';
  const onlineBuoys = BUOYS.filter(b => b.online);
  const totale = waypoints.length;
  waypoints.forEach((w, i) => {
    const tr = document.createElement('tr');
    const opts = onlineBuoys.map(b => '<option value="' + b.id + '" ' + (w.buoyId===b.id?'selected':'') + '>' + b.name + '</option>').join('');
    const statusMap = {
      idle: '<span style="color:var(--grey);font-size:11px">—</span>',
      going: '<span style="color:var(--orange);font-size:11px;font-weight:700">▶ Rotta</span>',
      fixed: '<span style="color:var(--green);font-size:11px;font-weight:700">✓ FIX</span>',
    };
    let distTxt = '—';
    if(totale > 1){
      const successiva = waypoints[(i+1) % totale];
      distTxt = Math.round(distanzaMetri(w, successiva)) + ' m';
    }
    tr.innerHTML = '<td><div style="width:24px;height:24px;border-radius:50%;background:#e65100;color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">' + w.n + '</div></td><td style="font-size:11px;color:var(--grey)">' + w.lat.toFixed(4) + '°N<br>' + w.lon.toFixed(4) + '°E</td><td style="font-size:11px;color:var(--grey);white-space:nowrap">→ ' + distTxt + '</td><td><select class="buoy-select" onchange="assignBuoy(' + i + ',this.value)"><option value="">Seleziona...</option>' + opts + '</select></td><td>' + (statusMap[w.status]||'—') + '</td><td><button class="wp-del" onclick="deleteWp(' + i + ')">✕</button></td>';
    tbody.appendChild(tr);
  });
  updateCourseStats();
}

function assignBuoy(idx, buoyId){
  waypoints[idx].buoyId = buoyId ? parseInt(buoyId) : null;
  updateCourseStats();
}

function updateCourseStats(){
  const assigned = waypoints.filter(w => w.buoyId).length;
  const total = waypoints.length;
  document.getElementById('course-pos').textContent = total;
  document.getElementById('course-assigned').textContent = assigned + ' / ' + total;
  let dist = 0;
  for(let i=0; i<total; i++){
    dist += distanzaMetri(waypoints[i], waypoints[(i+1)%total]);
  }
  document.getElementById('course-dist').textContent = total>1 ? (dist/1000).toFixed(2)+' km' : '—';
  const canDeploy = total>0 && assigned===total;
  const btn = document.getElementById('deploy-btn');
  btn.disabled = !canDeploy;
  btn.style.opacity = canDeploy ? '1' : '.4';
  btn.style.cursor = canDeploy ? 'pointer' : 'not-allowed';
}

function deployCourse(){
  const statusDiv = document.getElementById('deploy-status');
  const list = document.getElementById('deploy-list');
  statusDiv.style.display = 'block';
  list.innerHTML = '';
  waypoints.forEach(w => w.status = 'going');
  renderWpTable();

  fetch(API_BASE + '/api/deploy-course', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({waypoints: waypoints.map(w => ({n: w.n, lat: w.lat, lon: w.lon, buoy_id: w.buoyId}))})
  }).then(r => r.json()).then(data => {
    list.innerHTML = '';
    data.results.forEach(res => {
      const b = BUOYS.find(x => x.id === res.buoy_id);
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;background:var(--bg);border-radius:8px;padding:8px 10px;font-size:12px;border:1px solid var(--border)';
      const stato = res.ok ? '<span style="color:var(--orange);font-weight:700">▶ Comando inviato</span>' : '<span style="color:var(--red);font-weight:700">✕ Boa offline</span>';
      item.innerHTML = '<div style="width:22px;height:22px;border-radius:50%;background:#e65100;color:white;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">' + res.waypoint + '</div><div style="flex:1;font-weight:600">' + (b?b.name:'—') + '</div><div style="font-size:11px">' + stato + '</div>';
      list.appendChild(item);
      addLog((b?b.name:'Boa') + ' → Posizione ' + res.waypoint + (res.ok ? '' : ' (non in linea)'), res.ok ? 'ok' : 'err');
    });
  });
}

function clearPercorso(){
  waypoints = [];
  wpMarkers.forEach(m => map.removeLayer(m)); wpMarkers = [];
  if(wpLine){ map.removeLayer(wpLine); wpLine = null; }
  renderWpTable();
  document.getElementById('deploy-status').style.display = 'none';
  document.getElementById('st-wp').textContent = 0;
  document.getElementById('wp-count-tab').textContent = 0;
  if(wpMode) toggleWaypointMode();
  addLog('Percorso cancellato');
}

function deleteWp(i){
  waypoints.splice(i, 1);
  waypoints.forEach((w, j) => w.n = j+1);
  wpMarkers.forEach(m => map.removeLayer(m)); wpMarkers = [];
  if(wpLine){ map.removeLayer(wpLine); wpLine = null; }
  waypoints.forEach(w => { wpMarkers.push(creaMarkerWaypoint(w)); });
  updateCourseLine();
  renderWpTable();
  document.getElementById('st-wp').textContent = waypoints.length;
  document.getElementById('wp-count-tab').textContent = waypoints.length;
}

// ── SIDEBAR ──
function renderSidebar(f){
  f = f || '';
  const list = document.getElementById('buoy-list');
  list.innerHTML = '';
  if(BUOYS.length === 0){
    list.innerHTML = '<div class="no-buoys">Nessuna boa registrata.<br>Premi "Aggiungi boa" per iniziare.</div>';
    return;
  }
  BUOYS.filter(b => b.name.toLowerCase().includes(f.toLowerCase())).forEach(b => {
    const c = MODE_COLORS[b.mode] || '#546e7a';
    const div = document.createElement('div');
    div.className = 'bi' + (b.id === selectedId ? ' active' : '');
    div.onclick = () => selectBuoy(b.id);
    const subInfo = role === 'admin'
      ? b.clubName + (b.online ? ' · '+(b.volt>0?b.volt.toFixed(1)+'V':'online') : ' · offline')
      : (b.online ? (b.volt>0?b.volt.toFixed(1)+'V · ':'')+b.sat+' sat' : 'Non raggiungibile');
    div.innerHTML = '<div class="bi-dot" style="background:' + (b.online?c:'#546e7a') + '"></div><div class="bi-info"><div class="bi-name">' + b.name + '</div><div class="bi-sub">' + subInfo + '</div></div><span class="bi-badge" style="background:' + (b.online?c+'22':'rgba(84,110,122,.15)') + ';color:' + (b.online?c:'#546e7a') + '">' + b.mode + '</span>';
    list.appendChild(div);
  });
}
function filterBuoys(v){ renderSidebar(v); }

// ── SELECT BUOY ──
function selectBuoy(id){
  selectedId = id;
  const b = BUOYS.find(x => x.id === id);
  renderSidebar();
  if(b){
    updatePanel(b);
    if(b.lat && b.lon) map.flyTo([b.lat, b.lon], 14, {duration: 1.2});
    document.querySelectorAll('.cbtn').forEach(btn => btn.disabled = !b.online);
  }
}
function updatePanel(b){
  document.getElementById('p-name').textContent = b.name;
  document.getElementById('p-club').textContent = clubName;
  document.getElementById('p-mode').textContent = b.mode;
  document.getElementById('p-mode').className = 'mbadge ' + b.mode;
  document.getElementById('p-volt').textContent = b.volt>0 ? b.volt.toFixed(1) : '—';
  document.getElementById('p-volt').className = b.volt>=12?'vg':b.volt>=11.5?'vw':'vr';
  document.getElementById('p-sat').textContent = b.sat>0 ? b.sat : '—';
  document.getElementById('p-sat').className = b.sat>=8?'vg':b.sat>=4?'vw':'vr';
  document.getElementById('p-armed').textContent = b.armed ? 'ARMATA' : 'Disarmata';
  document.getElementById('p-armed').style.color = b.armed ? 'var(--red)' : 'var(--green)';
  document.getElementById('p-coords').innerHTML = (b.online && b.lat) ? b.lat.toFixed(6)+'° N<br>'+b.lon.toFixed(6)+'° E' : 'N/D';
  document.getElementById('p-conn').innerHTML = b.online ?
    '<div style="width:7px;height:7px;border-radius:50%;background:#66bb6a"></div><span style="color:var(--green)">Connessa</span>' :
    '<div style="width:7px;height:7px;border-radius:50%;background:#ef5350"></div><span style="color:var(--red)">Disconnessa</span>';
  document.getElementById('p-uptime').textContent = b.lastSeen ? new Date(b.lastSeen).toLocaleTimeString() : '—';
}

// ── COMANDI ──
function sendCmd(cmd){
  if(!selectedId) return;
  fetch(API_BASE + '/api/command', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({buoy_id: selectedId, cmd: cmd})
  }).then(r => {
    if(r.ok){
      addLog('Comando ' + cmd.toUpperCase() + ' inviato', 'ok');
      fb('Comando inviato');
    } else {
      addLog('Errore comando ' + cmd, 'err');
      fb('Boa non connessa');
    }
  });
}
function fb(msg){
  document.getElementById('ctrl-fb').textContent = msg;
  clearTimeout(fbTimer);
  fbTimer = setTimeout(() => { document.getElementById('ctrl-fb').textContent = 'Seleziona un comando'; }, 3000);
}

// ── CALIBRAZIONE (comando reale) ──
// ── CALIBRAZIONE BUSSOLA (comandi reali) ──
let calibrazioneInCorso = false;

function openCalibrazione(){
  const b = BUOYS.find(x => x.id === selectedId);
  calibrazioneInCorso = !!(b && b.calibrazione);
  aggiornaUiCalibrazione();
  openModal('modal-bussola');
}

function avviaCalibrazioneReale(){
  if(!selectedId) return;
  const cmd = calibrazioneInCorso ? 'calibrate_stop' : 'calibrate_start';
  fetch(API_BASE + '/api/command', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({buoy_id: selectedId, cmd: cmd})
  }).then(r => {
    if(r.ok){
      calibrazioneInCorso = !calibrazioneInCorso;
      aggiornaUiCalibrazione();
      addLog(calibrazioneInCorso ? 'Calibrazione bussola avviata' : 'Calibrazione bussola fermata e salvata', 'ok');
    } else {
      addLog('Boa non connessa — comando non inviato', 'err');
    }
  });
}

function aggiornaUiCalibrazione(){
  const btn = document.getElementById('cal-action-btn');
  const status = document.getElementById('cal-status');
  if(calibrazioneInCorso){
    btn.textContent = 'Ferma e salva';
    status.textContent = 'Calibrazione in corso — ruota la boa su tutti gli assi';
    status.style.color = 'var(--orange)';
  } else {
    btn.textContent = 'Avvia calibrazione';
    status.textContent = 'Pronto per la calibrazione';
    status.style.color = 'var(--grey)';
  }
}

// ── TEST MOTORI (comandi reali via MAV_CMD_DO_MOTOR_TEST) ──
function updateMotor(side, val){
  document.getElementById('m'+(side==='left'?'l':'r')+'-val').textContent = val;
}

function avviaTestMotori(){
  if(!selectedId) return;
  const sinistra = parseInt(document.getElementById('ml-slider').value);
  const destra = parseInt(document.getElementById('mr-slider').value);
  fetch(API_BASE + '/api/command', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({buoy_id: selectedId, cmd: 'motor_test', params: {sinistra: sinistra, destra: destra, durata: 3}})
  }).then(r => {
    if(r.ok){
      ['left','right'].forEach(s => document.getElementById('ind-'+s).classList.add('spinning'));
      addLog('Test motori avviato: sinistro '+sinistra+'% · destro '+destra+'%', 'warn');
      setTimeout(() => { ['left','right'].forEach(s => document.getElementById('ind-'+s).classList.remove('spinning')); }, 3000);
    } else {
      addLog('Boa non connessa — test motori non avviato', 'err');
    }
  });
}

function fermaTestMotori(){
  if(!selectedId) return;
  fetch(API_BASE + '/api/command', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({buoy_id: selectedId, cmd: 'motor_test_stop'})
  }).then(() => {
    ['left','right'].forEach(s => document.getElementById('ind-'+s).classList.remove('spinning'));
    addLog('Test motori fermato', 'warn');
  });
}

function emergenzaMotori(){
  fermaTestMotori();
  closeModal('modal-settings');
}

// ── TABS / MODAL ──
function switchTab(id, el){
  document.querySelectorAll('.bp-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.bp-content').forEach(c => c.classList.remove('active'));
  if(el) el.classList.add('active');
  document.getElementById('tab-'+id).classList.add('active');
}
function openModal(id){ document.getElementById(id).classList.add('show'); }
function closeModal(id){ document.getElementById(id).classList.remove('show'); }
function openSettings(tab){ openModal('modal-settings'); }
function openAddBuoy(){
  if(role === 'admin'){
    document.getElementById('addbuoy-club-info').style.display = 'none';
    document.getElementById('addbuoy-admin-form').style.display = 'block';
    document.getElementById('new-buoy-name').value = '';
    document.getElementById('code-result').style.display = 'none';
    caricaClubs();
  } else {
    document.getElementById('addbuoy-club-info').style.display = 'block';
    document.getElementById('addbuoy-admin-form').style.display = 'none';
  }
  openModal('modal-addbuoy');
}

function generateCode(){
  const name = document.getElementById('new-buoy-name').value || ('AM-' + Math.floor(Math.random()*900+100));
  const body = {buoy_name: name};
  if(role === 'admin'){
    const sel = document.getElementById('new-buoy-club');
    if(sel.value) body.club_id = parseInt(sel.value);
  }
  fetch(API_BASE + '/api/buoys/generate-code', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify(body)
  }).then(r => r.json()).then(data => {
    document.getElementById('pairing-code').textContent = data.code;
    document.getElementById('code-result').style.display = 'block';
    addLog('Codice generato per "' + name + '"', 'ok');
  });
}

// ── LOG ──
function addLog(msg, type){
  type = type || '';
  const c = document.getElementById('log-container');
  const now = new Date();
  const t = String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+':'+String(now.getSeconds()).padStart(2,'0');
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = '<span class="log-time">'+t+'</span><span class="log-'+(type||'msg')+'">'+msg+'</span>';
  c.insertBefore(div, c.firstChild);
  if(c.children.length > 50) c.removeChild(c.lastChild);
}

// ── STATS BAR ──
function updateStatsBar(){
  const on = BUOYS.filter(b => b.online).length;
  const fix = BUOYS.filter(b => b.mode === 'LOITER').length;
  const withVolt = BUOYS.filter(b => b.volt > 0);
  const withSat = BUOYS.filter(b => b.sat > 0);
  const avgV = withVolt.length ? withVolt.reduce((a,b)=>a+b.volt,0)/withVolt.length : 0;
  const avgS = withSat.length ? Math.round(withSat.reduce((a,b)=>a+b.sat,0)/withSat.length) : 0;
  document.getElementById('tb-online').textContent = on;
  document.getElementById('st-online').textContent = on + '/' + BUOYS.length;
  document.getElementById('st-fix').textContent = fix;
  document.getElementById('st-volt').textContent = avgV > 0 ? avgV.toFixed(1)+'V' : '—';
  document.getElementById('st-sat').textContent = avgS > 0 ? avgS : '—';
}
