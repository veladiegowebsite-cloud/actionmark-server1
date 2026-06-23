"""
Action Mark — Centralino (server)
Gestisce: login club, registrazione boe con codice, connessione boe via WebSocket,
connessione dashboard via WebSocket, comandi (fix/free/hold/rtl), percorso regata
(waypoints), impostazioni (parametri/bussola/motori).
"""

import json
import os
import random
import sqlite3
import string
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from passlib.context import CryptContext
from jose import jwt, JWTError

# ── Configurazione ────────────────────────────────────────
SECRET_KEY = "cambia-questa-chiave-con-qualcosa-di-lungo-e-segreto"
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 12
DB_PATH = "actionmark.db"

app = FastAPI(title="Action Mark Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ── Database ───────────────────────────────────────────────
@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _rendi_nullable(db, table: str, column: str):
    """Se la colonna esisteva con NOT NULL (versione vecchia del database),
    ricrea la tabella permettendo valori vuoti, senza perdere i dati."""
    info = db.execute(f"PRAGMA table_info({table})").fetchall()
    col = next((c for c in info if c["name"] == column), None)
    if col and col["notnull"] == 1:
        cols_def = ", ".join(c["name"] for c in info)
        db.execute(f"ALTER TABLE {table} RENAME TO {table}_old")
        if table == "buoys":
            db.execute("""
                CREATE TABLE buoys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    club_id INTEGER,
                    name TEXT NOT NULL,
                    api_key TEXT UNIQUE NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(club_id) REFERENCES clubs(id)
                )
            """)
        elif table == "pairing_codes":
            db.execute("""
                CREATE TABLE pairing_codes (
                    code TEXT PRIMARY KEY,
                    club_id INTEGER,
                    buoy_name TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0
                )
            """)
        db.execute(f"INSERT INTO {table} ({cols_def}) SELECT {cols_def} FROM {table}_old")
        db.execute(f"DROP TABLE {table}_old")


def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS clubs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'club',
                created_at TEXT NOT NULL
            )
        """)
        cols = [r["name"] for r in db.execute("PRAGMA table_info(clubs)").fetchall()]
        if "role" not in cols:
            db.execute("ALTER TABLE clubs ADD COLUMN role TEXT NOT NULL DEFAULT 'club'")

        db.execute("""
            CREATE TABLE IF NOT EXISTS buoys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                club_id INTEGER,
                name TEXT NOT NULL,
                api_key TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(club_id) REFERENCES clubs(id)
            )
        """)
        _rendi_nullable(db, "buoys", "club_id")

        db.execute("""
            CREATE TABLE IF NOT EXISTS pairing_codes (
                code TEXT PRIMARY KEY,
                club_id INTEGER,
                buoy_name TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used INTEGER NOT NULL DEFAULT 0
            )
        """)
        _rendi_nullable(db, "pairing_codes", "club_id")

        admin = db.execute("SELECT id FROM clubs WHERE role = 'admin'").fetchone()
        if not admin:
            db.execute(
                "INSERT INTO clubs (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
                ("Action Mark Admin", "admin@actionmark.it", pwd_context.hash("actionmark2026"), datetime.utcnow().isoformat()),
            )


@app.on_event("startup")
def on_startup():
    init_db()


# ── Auth helpers ───────────────────────────────────────────
def create_token(club_id: int) -> str:
    payload = {
        "club_id": club_id,
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> int:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return payload["club_id"]
    except JWTError:
        raise HTTPException(status_code=401, detail="Token non valido o scaduto")


def get_current_club(authorization: str = Header(None)) -> sqlite3.Row:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token mancante")
    token = authorization.removeprefix("Bearer ")
    club_id = verify_token(token)
    with get_db() as db:
        club = db.execute("SELECT * FROM clubs WHERE id = ?", (club_id,)).fetchone()
    if not club:
        raise HTTPException(status_code=401, detail="Account non trovato")
    return club


def require_admin(club: sqlite3.Row = Depends(get_current_club)) -> sqlite3.Row:
    if club["role"] != "admin":
        raise HTTPException(status_code=403, detail="Solo l'amministratore può fare questa operazione")
    return club


# ── Modelli richieste ──────────────────────────────────────
class LoginRequest(BaseModel):
    email: str
    password: str


class GenerateCodeRequest(BaseModel):
    buoy_name: str
    club_id: Optional[int] = None  # usato solo dall'admin per scegliere il club destinatario


class CreateClubRequest(BaseModel):
    name: str
    email: str
    password: str


class ActivateRequest(BaseModel):
    code: str


class CommandRequest(BaseModel):
    buoy_id: int
    cmd: str
    params: Optional[dict] = None


class DeployCourseRequest(BaseModel):
    waypoints: list  # [{n, lat, lon, buoy_id}, ...]


# ── Gestore connessioni in memoria ─────────────────────────
class ConnectionManager:
    def __init__(self):
        self.buoy_sockets: dict[int, WebSocket] = {}
        self.buoy_state: dict[int, dict] = {}
        self.dashboard_sockets: dict[int, list[WebSocket]] = {}
        self.admin_sockets: list[WebSocket] = []

    async def register_buoy(self, buoy_id: int, ws: WebSocket):
        self.buoy_sockets[buoy_id] = ws
        self.buoy_state[buoy_id] = {"online": True, "last_seen": time.time()}

    def unregister_buoy(self, buoy_id: int):
        self.buoy_sockets.pop(buoy_id, None)
        if buoy_id in self.buoy_state:
            self.buoy_state[buoy_id]["online"] = False

    async def register_dashboard(self, club_id: int, ws: WebSocket, is_admin: bool = False):
        if is_admin:
            self.admin_sockets.append(ws)
        else:
            self.dashboard_sockets.setdefault(club_id, []).append(ws)

    def unregister_dashboard(self, club_id: int, ws: WebSocket, is_admin: bool = False):
        if is_admin:
            if ws in self.admin_sockets:
                self.admin_sockets.remove(ws)
        else:
            if club_id in self.dashboard_sockets and ws in self.dashboard_sockets[club_id]:
                self.dashboard_sockets[club_id].remove(ws)

    async def send_to_buoy(self, buoy_id: int, message: dict) -> bool:
        ws = self.buoy_sockets.get(buoy_id)
        if not ws:
            return False
        await ws.send_text(json.dumps(message))
        return True

    async def broadcast_to_club(self, club_id: int, message: dict):
        sockets = list(self.dashboard_sockets.get(club_id, [])) + list(self.admin_sockets)
        for ws in sockets:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                pass


manager = ConnectionManager()


# ── REST: autenticazione ───────────────────────────────────
@app.post("/auth/login")
def login(req: LoginRequest):
    with get_db() as db:
        club = db.execute("SELECT * FROM clubs WHERE email = ?", (req.email,)).fetchone()
    if not club or not pwd_context.verify(req.password, club["password_hash"]):
        raise HTTPException(status_code=401, detail="Email o password errati")
    token = create_token(club["id"])
    return {"token": token, "club_name": club["name"], "role": club["role"]}


# ── REST: gestione club (solo admin) ────────────────────────
@app.post("/api/clubs")
def create_club(req: CreateClubRequest, admin: sqlite3.Row = Depends(require_admin)):
    with get_db() as db:
        existing = db.execute("SELECT id FROM clubs WHERE email = ?", (req.email,)).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Email già registrata")
        cursor = db.execute(
            "INSERT INTO clubs (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'club', ?)",
            (req.name, req.email, pwd_context.hash(req.password), datetime.utcnow().isoformat()),
        )
    return {"id": cursor.lastrowid, "name": req.name, "email": req.email}


@app.get("/api/clubs")
def list_clubs(admin: sqlite3.Row = Depends(require_admin)):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, name, email, created_at FROM clubs WHERE role = 'club'"
        ).fetchall()
    return [dict(r) for r in rows]


# ── REST: gestione boe ─────────────────────────────────────
@app.get("/api/buoys")
def list_buoys(club: sqlite3.Row = Depends(get_current_club)):
    with get_db() as db:
        if club["role"] == "admin":
            rows = db.execute("""
                SELECT buoys.id, buoys.name, buoys.club_id, clubs.name AS club_name
                FROM buoys LEFT JOIN clubs ON clubs.id = buoys.club_id
            """).fetchall()
        else:
            rows = db.execute(
                "SELECT id, name, club_id FROM buoys WHERE club_id = ?", (club["id"],)
            ).fetchall()
    result = []
    for row in rows:
        state = manager.buoy_state.get(row["id"], {"online": False})
        club_name = club["name"]
        if club["role"] == "admin":
            club_name = row["club_name"] or "Non assegnata"
        result.append({
            "id": row["id"],
            "name": row["name"],
            "club_id": row["club_id"],
            "club_name": club_name,
            "online": state.get("online", False),
            "telemetry": state.get("telemetry", {}),
        })
    return result


@app.post("/api/buoys/generate-code")
def generate_code(req: GenerateCodeRequest, admin: sqlite3.Row = Depends(require_admin)):
    # Solo l'admin (team Action Mark) può registrare nuove boe.
    # Il club è opzionale: se non specificato, la boa resta "non assegnata".
    target_club_id = req.club_id

    code = "".join(random.choices(string.digits, k=6))
    expires = (datetime.utcnow() + timedelta(minutes=15)).isoformat()
    with get_db() as db:
        db.execute(
            "INSERT INTO pairing_codes (code, club_id, buoy_name, expires_at, used) VALUES (?, ?, ?, ?, 0)",
            (code, target_club_id, req.buoy_name, expires),
        )
    return {"code": code, "expires_at": expires}


@app.post("/api/buoys/activate")
def activate_buoy(req: ActivateRequest):
    """Chiamata dalla pagina /attiva sul Raspberry Pi della boa."""
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM pairing_codes WHERE code = ? AND used = 0", (req.code,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="Codice non valido o già usato")
        if datetime.fromisoformat(row["expires_at"]) < datetime.utcnow():
            raise HTTPException(status_code=400, detail="Codice scaduto")

        api_key = "am_k_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=32))
        cursor = db.execute(
            "INSERT INTO buoys (club_id, name, api_key, created_at) VALUES (?, ?, ?, ?)",
            (row["club_id"], row["buoy_name"], api_key, datetime.utcnow().isoformat()),
        )
        buoy_id = cursor.lastrowid
        db.execute("UPDATE pairing_codes SET used = 1 WHERE code = ?", (req.code,))

    return {"buoy_id": buoy_id, "api_key": api_key}


# ── REST: comandi e percorso ────────────────────────────────
@app.post("/api/command")
async def send_command(req: CommandRequest, club: sqlite3.Row = Depends(get_current_club)):
    with get_db() as db:
        if club["role"] == "admin":
            buoy = db.execute("SELECT * FROM buoys WHERE id = ?", (req.buoy_id,)).fetchone()
        else:
            buoy = db.execute(
                "SELECT * FROM buoys WHERE id = ? AND club_id = ?", (req.buoy_id, club["id"])
            ).fetchone()
    if not buoy:
        raise HTTPException(status_code=404, detail="Boa non trovata")

    message = {"type": "command", "cmd": req.cmd}
    if req.params:
        message.update(req.params)

    sent = await manager.send_to_buoy(req.buoy_id, message)
    if not sent:
        raise HTTPException(status_code=409, detail="Boa non connessa al momento")
    return {"ok": True}


@app.post("/api/deploy-course")
async def deploy_course(req: DeployCourseRequest, club: sqlite3.Row = Depends(get_current_club)):
    """Manda ogni boa assegnata alla sua posizione del percorso regata."""
    results = []
    with get_db() as db:
        if club["role"] == "admin":
            owned_ids = {r["id"] for r in db.execute("SELECT id FROM buoys").fetchall()}
        else:
            owned_ids = {
                r["id"] for r in db.execute("SELECT id FROM buoys WHERE club_id = ?", (club["id"],)).fetchall()
            }
    for wp in req.waypoints:
        buoy_id = wp.get("buoy_id")
        if buoy_id not in owned_ids:
            results.append({"waypoint": wp["n"], "ok": False, "reason": "boa non del club"})
            continue
        message = {
            "type": "command",
            "cmd": "goto_and_fix",
            "lat": wp["lat"],
            "lon": wp["lon"],
        }
        sent = await manager.send_to_buoy(buoy_id, message)
        results.append({"waypoint": wp["n"], "buoy_id": buoy_id, "ok": sent})
    return {"results": results}


# ── WebSocket: boa ──────────────────────────────────────────
@app.websocket("/buoy/ws")
async def buoy_ws(ws: WebSocket):
    await ws.accept()
    buoy_id = None
    club_id = None
    try:
        auth_raw = await ws.receive_text()
        auth = json.loads(auth_raw)
        api_key = auth.get("api_key")

        with get_db() as db:
            row = db.execute("SELECT * FROM buoys WHERE api_key = ?", (api_key,)).fetchone()
        if not row:
            await ws.send_text(json.dumps({"type": "auth_error", "msg": "API key non valida"}))
            await ws.close()
            return

        buoy_id = row["id"]
        club_id = row["club_id"]
        await manager.register_buoy(buoy_id, ws)
        await ws.send_text(json.dumps({"type": "auth_ok", "buoy_id": buoy_id}))
        await manager.broadcast_to_club(club_id, {"type": "status", "buoy_id": buoy_id, "online": True})

        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)
            if data.get("type") == "telemetry":
                manager.buoy_state[buoy_id]["telemetry"] = data
                manager.buoy_state[buoy_id]["last_seen"] = time.time()
                await manager.broadcast_to_club(club_id, {"type": "telemetry", "buoy_id": buoy_id, **data})

    except WebSocketDisconnect:
        pass
    finally:
        if buoy_id is not None:
            manager.unregister_buoy(buoy_id)
            if club_id is not None:
                await manager.broadcast_to_club(club_id, {"type": "status", "buoy_id": buoy_id, "online": False})


# ── WebSocket: dashboard ─────────────────────────────────────
@app.websocket("/dashboard/ws")
async def dashboard_ws(ws: WebSocket, token: str):
    try:
        club_id = verify_token(token)
    except HTTPException:
        await ws.close(code=4001)
        return

    with get_db() as db:
        club = db.execute("SELECT role FROM clubs WHERE id = ?", (club_id,)).fetchone()
    is_admin = bool(club and club["role"] == "admin")

    await ws.accept()
    await manager.register_dashboard(club_id, ws, is_admin)
    try:
        while True:
            await ws.receive_text()  # la dashboard non manda nulla qui, usa le REST per i comandi
    except WebSocketDisconnect:
        pass
    finally:
        manager.unregister_dashboard(club_id, ws, is_admin)


@app.get("/")
def health():
    return {"status": "Action Mark server attivo"}


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard():
    path = os.path.join(os.path.dirname(__file__), "dashboard.html")
    with open(path, encoding="utf-8") as f:
        return f.read()


@app.get("/dashboard.js")
def dashboard_js():
    from fastapi.responses import Response
    path = os.path.join(os.path.dirname(__file__), "dashboard.js")
    with open(path, encoding="utf-8") as f:
        return Response(content=f.read(), media_type="application/javascript")
