/**
 * Catan P2P Serverless - Core Client MVP
 */

// --- GLOBAL GAME STATE ---
const STATE = {
  peer: null,
  conn: null,
  isHost: false,
  myPlayerId: null, // 'p1' (host) or 'p2' (client)
  gameState: {
    turn: 1, // turn counter
    activePlayer: 'p1', // whose turn it is
    phase: 'waiting', // waiting, rolling, building
    players: {
      p1: { vp: 0, res: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 } },
      p2: { vp: 0, res: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 } }
    },
    board: {
      hexes: [],
      nodes: {}, // format: "x,y": { owner, type }
      edges: {}  // format: "x1,y1_x2,y2": { owner }
    }
  }
};

// --- DOM ELEMENTS ---
const UI = {
  menuOverlay: document.getElementById('menu-overlay'),
  mainMenu: document.getElementById('main-menu'),
  hostingMenu: document.getElementById('hosting-menu'),
  connectingMenu: document.getElementById('connecting-menu'),
  gameOverMenu: document.getElementById('game-over-menu'),
  appContainer: document.getElementById('game-container'),
  
  hostIdDisplay: document.getElementById('display-host-id'),
  inputJoinId: document.getElementById('input-join-id'),
  
  btnHost: document.getElementById('btn-host'),
  btnJoin: document.getElementById('btn-join'),
  btnCancelHost: document.getElementById('btn-cancel-host'),
  
  log: document.getElementById('game-log'),
  turnText: document.getElementById('turn-text')
};

// --- INITIALIZATION ---
function init() {
  bindMenuEvents();
}

function showMenu(menuId) {
  document.querySelectorAll('.menu-section').forEach(el => el.classList.remove('active'));
  document.getElementById(menuId).classList.add('active');
}

function logMsg(msg) {
  UI.log.textContent = msg;
  console.log(msg);
}

// --- PEERJS NETWORKING ---

function bindMenuEvents() {
  UI.btnHost.onclick = async () => {
    showMenu('connecting-menu');
    try {
      STATE.peer = new Peer({ debug: 2 });
      STATE.peer.on('open', id => {
        STATE.isHost = true;
        STATE.myPlayerId = 'p1';
        UI.hostIdDisplay.textContent = id;
        showMenu('hosting-menu');
        logMsg("Waiting for peer to connect...");
      });

      STATE.peer.on('connection', conn => {
        STATE.conn = conn;
        setupConnection();
        startGameHost();
      });

      STATE.peer.on('error', err => {
        alert("PeerJS Error: " + err.type);
        showMenu('main-menu');
      });

    } catch (e) {
      alert("Error initializing host: " + e.message);
      showMenu('main-menu');
    }
  };

  UI.btnCancelHost.onclick = () => {
    if (STATE.peer) STATE.peer.destroy();
    showMenu('main-menu');
  };

  UI.btnJoin.onclick = () => {
    const hostId = UI.inputJoinId.value.trim();
    if (!hostId) return alert("Enter a valid Host ID");
    
    showMenu('connecting-menu');
    STATE.peer = new Peer({ debug: 2 });
    
    STATE.peer.on('open', id => {
      STATE.isHost = false;
      STATE.myPlayerId = 'p2';
      STATE.conn = STATE.peer.connect(hostId);
      
      STATE.conn.on('open', () => {
        setupConnection();
        logMsg("Connected to Host. Waiting for board...");
      });

      STATE.conn.on('error', err => {
        alert("Connection Error: " + err);
        showMenu('main-menu');
      });
    });

    STATE.peer.on('error', err => {
      alert("PeerJS Error: " + err.type);
      showMenu('main-menu');
    });
  };
}

function setupConnection() {
  STATE.conn.on('data', data => {
    handleNetworkMessage(data);
  });
  STATE.conn.on('close', () => {
    alert("Connection lost");
    location.reload();
  });
}

function sendNetworkMessage(msg) {
  if (STATE.conn && STATE.conn.open) {
    STATE.conn.send(msg);
  }
}

function handleNetworkMessage(msg) {
  if (msg.type === 'SYNC_STATE') {
    STATE.gameState = msg.state;
    updateUIFromState();
    
    if (UI.menuOverlay.classList.contains('active')) {
      UI.menuOverlay.classList.remove('active');
      UI.appContainer.classList.remove('hidden');
      logMsg("Game Started!");
    }
  }
  
  if (msg.type === 'ACTION_INTENT' && STATE.isHost) {
    processIntent(msg.player, msg.action, msg.data);
  }
  
  if (msg.type === 'LOG') {
    logMsg(msg.message);
  }
}

// --- HOST LOGIC: PROCESS INTENTS ---
function processIntent(player, action, data) {
  if (STATE.gameState.activePlayer !== player) return; // Not their turn
  
  let valid = false;
  let msg = '';

  if (action === 'ROLL') {
    if (STATE.gameState.phase !== 'rolling') return;
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const roll = d1 + d2;
    msg = `${player} rolled a ${roll}!`;
    
    if (roll === 7) {
      msg += " (Robber not implemented in MVP)";
    } else {
      generateResources(roll);
    }
    
    STATE.gameState.phase = 'building';
    valid = true;
    
    // Broadcast roll result
    broadcastLog(msg);
    showDice(d1, d2);
  }
  else if (action === 'END_TURN') {
    if (STATE.gameState.phase !== 'building') return;
    STATE.gameState.activePlayer = player === 'p1' ? 'p2' : 'p1';
    STATE.gameState.phase = 'rolling';
    STATE.gameState.turn++;
    valid = true;
    broadcastLog(`${player} ended their turn.`);
  }
  else if (action === 'BUILD') {
    if (STATE.gameState.phase !== 'building') return;
    valid = attemptBuild(player, data.type, data.id);
  }

  if (valid) {
    checkWinCondition();
    sendNetworkMessage({ type: 'SYNC_STATE', state: STATE.gameState });
  }
}

function generateResources(roll) {
  const { board, players } = STATE.gameState;
  board.hexes.forEach(hex => {
    if (hex.num === roll && hex.res !== 'desert') {
      // Find adjacent nodes with settlements/cities
      hex.vertices.forEach(vId => {
        const node = board.nodes[vId];
        if (node.owner) {
          const amount = node.type === 'city' ? 2 : 1;
          players[node.owner].res[hex.res] += amount;
        }
      });
    }
  });
}

function attemptBuild(player, type, id) {
  const pState = STATE.gameState.players[player];
  const { board } = STATE.gameState;
  
  if (type === 'road') {
    if (pState.res.wood < 1 || pState.res.brick < 1) return false;
    const edge = board.edges[id];
    if (edge.owner) return false; // already built
    
    // Enforce connected to existing road/settlement (simplified for MVP: just needs to be next to *any* owned node)
    // Actually, skipping complex adjacency checks for MVP simplicity, just taking resources.
    pState.res.wood--; pState.res.brick--;
    edge.owner = player;
    broadcastLog(`${player} built a Road.`);
    return true;
  }
  else if (type === 'settlement') {
    if (pState.res.wood < 1 || pState.res.brick < 1 || pState.res.wheat < 1 || pState.res.sheep < 1) return false;
    const node = board.nodes[id];
    if (node.owner) return false;
    
    pState.res.wood--; pState.res.brick--; pState.res.wheat--; pState.res.sheep--;
    node.owner = player;
    node.type = 'settlement';
    pState.vp += 1;
    broadcastLog(`${player} built a Settlement.`);
    return true;
  }
  else if (type === 'city') {
    if (pState.res.wheat < 2 || pState.res.ore < 3) return false;
    const node = board.nodes[id];
    if (node.owner !== player || node.type !== 'settlement') return false;
    
    pState.res.wheat -= 2; pState.res.ore -= 3;
    node.type = 'city';
    pState.vp += 1; // +1 since settlement was already +1 = total 2
    broadcastLog(`${player} upgraded to a City.`);
    return true;
  }
  return false;
}

function checkWinCondition() {
  ['p1', 'p2'].forEach(p => {
    if (STATE.gameState.players[p].vp >= 10) {
      STATE.gameState.phase = 'gameover';
      broadcastLog(`${p} wins the game!`);
    }
  });
}

function broadcastLog(msg) {
  logMsg(msg);
  if (STATE.conn && STATE.conn.open) {
    STATE.conn.send({ type: 'LOG', message: msg });
  }
}

// --- CLIENT ACTIONS ---

let buildMode = null; // 'road', 'settlement', 'city'

document.getElementById('btn-roll').onclick = () => {
  sendIntent('ROLL');
};

document.getElementById('btn-end-turn').onclick = () => {
  buildMode = null;
  document.body.classList.remove('building-mode-active');
  sendIntent('END_TURN');
};

document.getElementById('btn-build-road').onclick = () => toggleBuildMode('road');
document.getElementById('btn-build-settlement').onclick = () => toggleBuildMode('settlement');
document.getElementById('btn-build-city').onclick = () => toggleBuildMode('city');

function toggleBuildMode(mode) {
  if (buildMode === mode) {
    buildMode = null;
    document.body.classList.remove('building-mode-active');
    logMsg("Cancelled building.");
  } else {
    buildMode = mode;
    document.body.classList.add('building-mode-active');
    logMsg(`Select a spot to build a ${mode}...`);
  }
}

function handleBoardClick(type, id) {
  if (!buildMode) return;
  
  if (buildMode === 'road' && type === 'edge') {
    sendIntent('BUILD', { type: 'road', id });
    toggleBuildMode(buildMode); // reset toggle
  } else if ((buildMode === 'settlement' || buildMode === 'city') && type === 'node') {
    sendIntent('BUILD', { type: buildMode, id });
    toggleBuildMode(buildMode); // reset toggle
  }
}

function sendIntent(action, data = null) {
  if (STATE.gameState.activePlayer !== STATE.myPlayerId) {
    logMsg("Not your turn!");
    return;
  }
  
  if (STATE.isHost) {
    processIntent(STATE.myPlayerId, action, data);
  } else {
    sendNetworkMessage({ type: 'ACTION_INTENT', player: STATE.myPlayerId, action, data });
  }
}

function showDice(d1, d2) {
  const dc = document.getElementById('dice-result');
  dc.classList.remove('hidden');
  const dmap = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
  document.getElementById('dice-1').textContent = dmap[d1];
  document.getElementById('dice-2').textContent = dmap[d2];
}

// --- GAME LOGIC (HOST) ---
function startGameHost() {
  STATE.gameState = {
    turn: 1,
    activePlayer: 'p1',
    phase: 'rolling',
    players: {
      p1: { vp: 0, res: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 } },
      p2: { vp: 0, res: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 } }
    },
    board: { hexes: [], nodes: {}, edges: {} }
  };
  generateBoard();
  
  sendNetworkMessage({ type: 'SYNC_STATE', state: STATE.gameState });
  UI.menuOverlay.classList.remove('active');
  UI.appContainer.classList.remove('hidden');
  updateUIFromState();
}

function generateBoard() {
  const size = 60; // hex radius
  const w = Math.sqrt(3) * size;
  const h = 2 * size;
  
  // Layout defines row length
  const layout = [3, 4, 5, 4, 3];
  let resList = ['wood','wood','wood','wood', 'sheep','sheep','sheep','sheep', 'wheat','wheat','wheat','wheat', 'brick','brick','brick', 'ore','ore','ore', 'desert'];
  let numList = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  
  // Basic shuffle
  resList.sort(() => Math.random() - 0.5);
  numList.sort(() => Math.random() - 0.5);

  let hexId = 0;
  for (let r = 0; r < layout.length; r++) {
    const cols = layout[r];
    const y = (r - 2) * (h * 0.75);
    const xOffset = -(cols - 1) * w / 2;
    for (let c = 0; c < cols; c++) {
      const x = xOffset + c * w;
      
      const res = resList.pop();
      const num = res === 'desert' ? null : numList.pop();
      
      const hex = { id: hexId++, x, y, res, num, vertices: [] };
      
      // Calculate vertices (Pointy top)
      for (let i = 0; i < 6; i++) {
        const angle = Math.PI / 180 * (60 * i - 30);
        const vx = Math.round(x + size * Math.cos(angle));
        const vy = Math.round(y + size * Math.sin(angle));
        const vId = `${vx},${vy}`;
        
        hex.vertices.push(vId);
        
        // Register Node
        if (!STATE.gameState.board.nodes[vId]) {
          STATE.gameState.board.nodes[vId] = { id: vId, x: vx, y: vy, owner: null, type: null, hexes: [] };
        }
        STATE.gameState.board.nodes[vId].hexes.push(hex.id);
        
        // Register Edge (connecting current to previous vertex)
        if (i > 0) {
          const prevId = hex.vertices[i-1];
          const edgeId = [vId, prevId].sort().join('_');
          if (!STATE.gameState.board.edges[edgeId]) {
            STATE.gameState.board.edges[edgeId] = { id: edgeId, v1: prevId, v2: vId, owner: null };
          }
        }
      }
      // Close edge loop (v5 to v0)
      const lastEdgeId = [hex.vertices[5], hex.vertices[0]].sort().join('_');
      if (!STATE.gameState.board.edges[lastEdgeId]) {
        STATE.gameState.board.edges[lastEdgeId] = { id: lastEdgeId, v1: hex.vertices[5], v2: hex.vertices[0], owner: null };
      }
      
      STATE.gameState.board.hexes.push(hex);
    }
  }
}

// --- RENDERING / UI SYNC ---
function updateUIFromState() {
  const isMyTurn = STATE.gameState.activePlayer === STATE.myPlayerId;
  if (isMyTurn) {
    UI.turnText.textContent = "Your Turn (" + (STATE.gameState.phase === 'rolling' ? 'Roll Dice' : 'Build Phase') + ")";
    UI.turnText.style.color = 'white';
  } else {
    UI.turnText.textContent = "Opponent's Turn";
    UI.turnText.style.color = '#888';
  }
  
  ['p1', 'p2'].forEach(p => {
    document.getElementById(`${p}-vp`).textContent = STATE.gameState.players[p].vp;
    Object.keys(STATE.gameState.players[p].res).forEach(res => {
      document.getElementById(`${p}-${res}`).textContent = STATE.gameState.players[p].res[res];
    });
  });

  document.getElementById('btn-roll').style.display = (isMyTurn && STATE.gameState.phase === 'rolling') ? 'block' : 'none';
  
  const canBuild = isMyTurn && STATE.gameState.phase === 'building';
  document.getElementById('btn-build-road').disabled = !canBuild;
  document.getElementById('btn-build-settlement').disabled = !canBuild;
  document.getElementById('btn-build-city').disabled = !canBuild;
  document.getElementById('btn-end-turn').disabled = !canBuild;
  
  renderBoard();
}

function renderBoard() {
  const gHexes = document.getElementById('layer-hexes');
  const gEdges = document.getElementById('layer-edges');
  const gNodes = document.getElementById('layer-nodes');
  
  gHexes.innerHTML = '';
  gEdges.innerHTML = '';
  gNodes.innerHTML = '';

  const { board } = STATE.gameState;

  // Render Hexes
  board.hexes.forEach(hex => {
    const pts = hex.vertices.map(v => v.replace(',', ',')).join(' '); // x,y list
    
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", pts);
    poly.classList.add('hex-path', 'hex', hex.res);
    gHexes.appendChild(poly);

    // Number Token
    if (hex.num) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", hex.x); circle.setAttribute("cy", hex.y);
      circle.setAttribute("r", "16"); circle.classList.add("number-token");
      gHexes.appendChild(circle);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", hex.x); text.setAttribute("y", hex.y + 2);
      text.textContent = hex.num; text.classList.add("number-text");
      if (hex.num === 6 || hex.num === 8) text.style.fill = 'red';
      gHexes.appendChild(text);
    }
  });

  // Render Edges
  Object.values(board.edges).forEach(edge => {
    const [x1, y1] = edge.v1.split(',');
    const [x2, y2] = edge.v2.split(',');
    
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.classList.add('edge');
    if (edge.owner) line.classList.add('built', edge.owner);
    
    line.onclick = () => handleBoardClick('edge', edge.id);
    gEdges.appendChild(line);
  });

  // Render Nodes
  Object.values(board.nodes).forEach(node => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", node.x); circle.setAttribute("cy", node.y);
    circle.classList.add('node');
    if (node.owner) {
      circle.classList.add('built', node.owner);
      if (node.type === 'city') circle.classList.add('city');
    }
    
    circle.onclick = () => handleBoardClick('node', node.id);
    gNodes.appendChild(circle);
  });
}

function handleBoardClick(type, id) {
  // Client interaction for building
  // To be implemented
}

init();
