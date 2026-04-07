import sqlite3
import json
import logging
import os
import queue as _queue
import re
import threading
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, render_template, request, session, redirect, url_for, jsonify, g, Response, stream_with_context
import bcrypt
import requests

logging.basicConfig(level=logging.INFO)
log = logging.getLogger('grimoire')

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'grimoire-dev-secret-change-in-prod')

DATABASE = os.path.join(os.path.dirname(__file__), 'grimoire.db')
OLLAMA_URL = 'http://localhost:11434/api/generate'
OLLAMA_MODEL = 'mistral:7b'
XP_PER_LEVEL = 100

RANKS = [
    {'name': 'F', 'min_level': 1,  'color': '#6b6258'},
    {'name': 'E', 'min_level': 5,  'color': '#9a9488'},
    {'name': 'D', 'min_level': 10, 'color': '#78c6a3'},
    {'name': 'C', 'min_level': 15, 'color': '#74b2e0'},
    {'name': 'B', 'min_level': 20, 'color': '#9d8fe6'},
    {'name': 'A', 'min_level': 25, 'color': '#c9a227'},
    {'name': 'S', 'min_level': 30, 'color': '#e06b5a'},
]

DEFAULT_SCHOOLS = [
    {
        'name': 'Restoration',
        'flavour': 'The art of mending flesh and spirit — through nourishment, water, and sacred sleep.',
        'color': '#8b7fd4',
        'spells': [
            {'name': 'Somnium',      'description': 'Slept 7–9 hours',              'xp': 30},
            {'name': 'Vigil Sanus',  'description': 'Kept a consistent sleep schedule', 'xp': 25},
            {'name': 'Hydor',        'description': 'Drank 2L of water',             'xp': 25},
            {'name': 'Cibus Vitae',  'description': 'Ate fruits or vegetables',       'xp': 20},
            {'name': 'Hearth Oath',  'description': 'Cooked a healthy meal',          'xp': 25},
        ],
    },
    {
        'name': 'Transmutation',
        'flavour': 'To reshape the body is to defy entropy. Pain is the price; transformation, the reward.',
        'color': '#c9a227',
        'spells': [
            {'name': 'Rite of Iron',  'description': 'Completed a full workout',   'xp': 35},
            {'name': 'Swift Hex',     'description': 'Went for a run',             'xp': 25},
            {'name': 'Iter Fortis',   'description': 'Walked 8,000+ steps',        'xp': 20},
            {'name': 'Flexus',        'description': 'Stretched or did yoga',       'xp': 15},
        ],
    },
    {
        'name': 'Divination',
        'flavour': 'The mind is a mirror; left unpolished, it shows only shadow. Tend it with discipline.',
        'color': '#52b788',
        'spells': [
            {'name': 'Silentium',     'description': 'Meditated for 10+ minutes',  'xp': 25},
            {'name': 'Ink Rite',      'description': 'Journaled',                  'xp': 20},
            {'name': 'Natura Vigil',  'description': 'Spent time in nature',       'xp': 20},
            {'name': 'Gratia',        'description': 'Practised gratitude',         'xp': 15},
        ],
    },
    {
        'name': 'Artifice',
        'flavour': 'Craft and knowledge are power made manifest. Every completed work is a rune carved into the world.',
        'color': '#74b9e0',
        'spells': [
            {'name': 'Deep Vigil',  'description': 'Completed a 1h+ deep work session', 'xp': 30},
            {'name': 'Lexis',       'description': 'Read for 20+ minutes',               'xp': 20},
            {'name': 'Nova Runa',   'description': 'Learned something new',               'xp': 25},
            {'name': 'Opus',        'description': 'Completed a key task',                'xp': 20},
        ],
    },
    {
        'name': 'Enchantment',
        'flavour': 'The subtle art of binding souls \u2014 through word, deed, and genuine presence.',
        'color': '#d98fb0',
        'spells': [
            {'name': 'Binding Rite',  'description': 'Had a meaningful conversation',     'xp': 25},
            {'name': 'Tendrils Hex',  'description': 'Reached out to someone',            'xp': 20},
            {'name': 'Communion',     'description': 'Spent quality time with others',    'xp': 25},
            {'name': 'Kind Oath',     'description': 'Did something kind for someone',    'xp': 15},
        ],
    },
]

CUSTOM_COLORS = ['#e09b5a', '#a87bc4', '#5abeaa', '#e0c45a', '#c45a5a', '#5a8fe0']

# ── DB ────────────────────────────────────────────────────────────────────────

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA journal_mode=WAL')
        g.db.execute('PRAGMA foreign_keys=ON')
    return g.db


@app.teardown_appcontext
def close_db(e=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DATABASE)
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            ai_title TEXT
        );
        CREATE TABLE IF NOT EXISTS schools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            flavour TEXT NOT NULL,
            is_custom INTEGER NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#c9a227',
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS spells (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            xp INTEGER NOT NULL,
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS user_xp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            school_id INTEGER NOT NULL,
            xp INTEGER NOT NULL DEFAULT 0,
            UNIQUE(user_id, school_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS deed_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            school_id INTEGER NOT NULL,
            deed_name TEXT NOT NULL,
            xp INTEGER NOT NULL,
            is_custom INTEGER NOT NULL DEFAULT 0,
            augur_verdict TEXT,
            cast_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS milestones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            description TEXT NOT NULL,
            school_id INTEGER,
            occurred_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE SET NULL
        );
    ''')
    db.commit()
    db.close()


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_level(xp):
    return xp // XP_PER_LEVEL + 1


def get_xp_in_level(xp):
    return xp % XP_PER_LEVEL


def get_rank(level):
    rank = RANKS[0]
    for r in RANKS:
        if level >= r['min_level']:
            rank = r
    return rank


def record_milestone(db, user_id, type_, description, school_id=None):
    db.execute(
        'INSERT INTO milestones (user_id, type, description, school_id, occurred_at) VALUES (?,?,?,?,?)',
        (user_id, type_, description, school_id, datetime.utcnow().isoformat()),
    )


def require_login(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def require_login_api(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)
    return decorated


def call_augur(system_prompt, user_prompt, num_predict=400, retries=1, temperature=0.5, num_ctx=2048):
    full_prompt = f"{system_prompt}\n\n{user_prompt}"
    for attempt in range(retries + 1):
        try:
            resp = requests.post(OLLAMA_URL, json={
                'model': OLLAMA_MODEL,
                'prompt': full_prompt,
                'stream': False,
                'format': 'json',
                'options': {'temperature': temperature, 'num_predict': num_predict, 'num_ctx': num_ctx},
            }, timeout=90)
            resp.raise_for_status()
            raw = resp.json().get('response', '')
            raw = re.sub(r'```(?:json)?', '', raw).strip('` \n')
            return json.loads(raw)
        except requests.exceptions.Timeout:
            log.warning('call_augur timeout (attempt %d/%d)', attempt + 1, retries + 1)
        except requests.exceptions.RequestException as e:
            log.warning('call_augur request error (attempt %d/%d): %s', attempt + 1, retries + 1, e)
        except json.JSONDecodeError as e:
            log.warning('call_augur JSON parse error (attempt %d/%d): %s | raw: %.200s', attempt + 1, retries + 1, e, raw)
        except Exception as e:
            log.warning('call_augur unexpected error (attempt %d/%d): %s', attempt + 1, retries + 1, e)
    return None


def get_user_schools(user_id):
    db = get_db()
    rows = db.execute(
        'SELECT s.*, COALESCE(ux.xp, 0) as total_xp '
        'FROM schools s '
        'LEFT JOIN user_xp ux ON ux.school_id = s.id AND ux.user_id = ? '
        'WHERE s.user_id = ? ORDER BY s.is_custom ASC, s.id ASC',
        (user_id, user_id),
    ).fetchall()
    result = []
    for row in rows:
        school = dict(row)
        spells = db.execute(
            'SELECT * FROM spells WHERE school_id = ? ORDER BY id ASC',
            (school['id'],),
        ).fetchall()
        school['spells'] = [dict(sp) for sp in spells]
        xp = school['total_xp']
        level = get_level(xp)
        school['level'] = level
        school['xp_in_level'] = get_xp_in_level(xp)
        school['rank'] = get_rank(level)
        result.append(school)
    return result


def provision_user_schools(user_id, db):
    now = datetime.utcnow().isoformat()
    for sd in DEFAULT_SCHOOLS:
        cur = db.execute(
            'INSERT INTO schools (user_id, name, flavour, is_custom, color, created_at) VALUES (?,?,?,0,?,?)',
            (user_id, sd['name'], sd['flavour'], sd['color'], now),
        )
        school_id = cur.lastrowid
        for sp in sd['spells']:
            db.execute(
                'INSERT INTO spells (school_id, name, description, xp) VALUES (?,?,?,?)',
                (school_id, sp['name'], sp.get('description', ''), sp['xp']),
            )
        db.execute(
            'INSERT INTO user_xp (user_id, school_id, xp) VALUES (?,?,0)',
            (user_id, school_id),
        )
    db.commit()


def build_xp_result(db, user_id, school_id, xp_gained, deed_name, is_custom=False, verdict=None):
    xp_row = db.execute(
        'SELECT xp FROM user_xp WHERE user_id=? AND school_id=?',
        (user_id, school_id),
    ).fetchone()
    old_xp = xp_row['xp'] if xp_row else 0
    old_level = get_level(old_xp)
    new_xp = old_xp + xp_gained
    new_level = get_level(new_xp)

    db.execute(
        'INSERT OR REPLACE INTO user_xp (user_id, school_id, xp) VALUES (?,?,?)',
        (user_id, school_id, new_xp),
    )
    db.execute(
        'INSERT INTO deed_log (user_id, school_id, deed_name, xp, is_custom, augur_verdict, cast_at) '
        'VALUES (?,?,?,?,?,?,?)',
        (user_id, school_id, deed_name, xp_gained, 1 if is_custom else 0,
         verdict, datetime.utcnow().isoformat()),
    )
    db.commit()

    old_rank = get_rank(old_level)
    rank = get_rank(new_level)

    # Record milestones
    school_row = db.execute('SELECT name FROM schools WHERE id=?', (school_id,)).fetchone()
    school_name = school_row['name'] if school_row else 'Unknown'
    rank_change_level = new_level if rank['name'] != old_rank['name'] else None
    if new_level > old_level:
        for lv in range(old_level + 1, new_level + 1):
            if lv % 5 == 0 or lv == 1:
                # Skip standalone level milestone if a rank change also fires at this level
                if lv != rank_change_level:
                    record_milestone(db, user_id, 'level',
                        f'{school_name} reached Level {lv}', school_id)
    if rank_change_level:
        rank_verbs = {'E': 'reached', 'D': 'rose to', 'C': 'advanced to',
                      'B': 'climbed to', 'A': 'ascended to', 'S': 'transcended to'}
        verb = rank_verbs.get(rank['name'], 'reached')
        record_milestone(db, user_id, 'rank',
            f'{school_name} {verb} Rank {rank["name"]}', school_id)
    db.commit()

    return {
        'school_id': school_id,
        'new_xp': new_xp,
        'xp_gained': xp_gained,
        'level': new_level,
        'xp_in_level': get_xp_in_level(new_xp),
        'rank': rank,
        'leveled_up': new_level > old_level,
        'rank_changed': rank['name'] != old_rank['name'],
        'old_level': old_level,
    }


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('index'))
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        db = get_db()
        user = db.execute(
            'SELECT * FROM users WHERE username = ?', (username,)
        ).fetchone()
        if user and bcrypt.checkpw(password.encode(), user['password_hash'].encode()):
            session['user_id'] = user['id']
            session['username'] = user['username']
            return redirect(url_for('index'))
        error = 'Invalid credentials.'
    return render_template('login.html', error=error)


@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if 'user_id' in session:
        return redirect(url_for('index'))
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        if not username or not password:
            error = 'Username and password are required.'
        elif len(username) < 3 or len(username) > 30:
            error = 'Username must be 3\u201330 characters.'
        elif len(password) < 6:
            error = 'Password must be at least 6 characters.'
        else:
            db = get_db()
            existing = db.execute(
                'SELECT id FROM users WHERE username = ?', (username,)
            ).fetchone()
            if existing:
                error = 'Username already taken.'
            else:
                pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
                now = datetime.utcnow().isoformat()
                cur = db.execute(
                    'INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)',
                    (username, pw_hash, now),
                )
                user_id = cur.lastrowid
                db.commit()
                session['user_id'] = user_id
                session['username'] = username
                return redirect(url_for('index'))
    return render_template('signup.html', error=error)


@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/api/account/username', methods=['POST'])
@require_login_api
def api_change_username():
    user_id = session['user_id']
    data = request.get_json()
    new_username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    if len(new_username) < 3 or len(new_username) > 30:
        return jsonify({'error': 'Username must be 3–30 characters.'}), 400
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
    if not bcrypt.checkpw(password.encode(), user['password_hash'].encode()):
        return jsonify({'error': 'Incorrect password.'}), 403
    if db.execute('SELECT id FROM users WHERE username=? AND id!=?', (new_username, user_id)).fetchone():
        return jsonify({'error': 'That name is already claimed.'}), 409
    db.execute('UPDATE users SET username=? WHERE id=?', (new_username, user_id))
    db.commit()
    session['username'] = new_username
    return jsonify({'username': new_username})


@app.route('/api/account/password', methods=['POST'])
@require_login_api
def api_change_password():
    user_id = session['user_id']
    data = request.get_json()
    current_password = data.get('current_password') or ''
    new_password = data.get('new_password') or ''
    if len(new_password) < 6:
        return jsonify({'error': 'New password must be at least 6 characters.'}), 400
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
    if not bcrypt.checkpw(current_password.encode(), user['password_hash'].encode()):
        return jsonify({'error': 'Incorrect current password.'}), 403
    pw_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
    db.execute('UPDATE users SET password_hash=? WHERE id=?', (pw_hash, user_id))
    db.commit()
    return jsonify({'ok': True})


# ── Onboarding routes ─────────────────────────────────────────────────────────

@app.route('/api/onboard/skip', methods=['POST'])
@require_login_api
def api_onboard_skip():
    user_id = session['user_id']
    db = get_db()
    provision_user_schools(user_id, db)
    db.execute('UPDATE users SET onboarded=1 WHERE id=?', (user_id,))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/onboard/prepare', methods=['POST'])
@require_login_api
def api_onboard_prepare():
    data = request.get_json()
    schools = data.get('schools', [])
    if not isinstance(schools, list) or not schools:
        return jsonify({'error': 'No schools provided'}), 400
    session['onboarding_schools'] = schools
    return jsonify({'ok': True})


@app.route('/api/onboard/stream')
@require_login_api
def api_onboard_stream():
    schools = session.get('onboarding_schools', [])
    if not schools:
        return jsonify({'error': 'No onboarding data. Call /api/onboard/prepare first.'}), 400

    system = (
        'Augur: calibrate hero habits. '
        'JSON only: {"spells":[{"name":"string","description":"string","xp":number}]}. '
        '4-5 spells, logged after completion. '
        'R1: concrete real-world habits — never fantasy imagery or metaphors. '
        'R2: description = one plain sentence (e.g. "Walk 8000 steps"). '
        'R3: name = 2-4 word fantasy title only (e.g. "Rite of Iron"). '
        'XP 10-50 by effort. No markdown.'
    )

    event_q = _queue.SimpleQueue()

    def gen_school(idx, school):
        name = school.get('name', '')
        flavour = school.get('flavour', '')
        user_desc = (school.get('user_description') or '').strip()
        is_custom = school.get('is_custom', False)
        color = school.get('color', '#c9a227')

        # Custom schools should arrive named from the client; fall back to description
        if is_custom and not name:
            name = (school.get('plain_name') or user_desc)[:40]
            flavour = user_desc

        domain_examples = SCHOOL_HABIT_EXAMPLES.get(name, '')
        if not domain_examples:
            domain_examples = user_desc if user_desc else f'habits related to: {flavour}'

        user_msg = f'School: {name}, domain: {flavour}.\nExamples: {domain_examples}\n'
        if user_desc and is_custom:
            user_msg += f'User goal: {user_desc}\n'
        user_msg += 'New user setup. Generate starter habits.'

        full_prompt = f'{system}\n\n{user_msg}'

        event_q.put(json.dumps({"school_start": {"name": name, "color": color, "idx": idx}}))

        full_text = ''
        try:
            resp = requests.post(OLLAMA_URL, json={
                'model': OLLAMA_MODEL,
                'prompt': full_prompt,
                'stream': True,
                'format': 'json',
                'options': {'temperature': 0.4, 'num_predict': 320, 'num_ctx': 1024},
            }, stream=True, timeout=120)
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                token = chunk.get('response', '')
                full_text += token
                event_q.put(json.dumps({"t": token, "idx": idx}))
                if chunk.get('done'):
                    break
        except Exception as e:
            log.warning('onboard stream error (school %s): %s', name, e)
            event_q.put(json.dumps({"err": f"Could not generate spells for {name}.", "idx": idx}))
            event_q.put(None)
            return

        try:
            raw = re.sub(r'```(?:json)?', '', full_text).strip('` \n')
            # If JSON was truncated, try to close it before parsing
            if raw and not raw.rstrip().endswith('}'):
                raw = raw.rstrip().rstrip(',') + ']}'
            result = json.loads(raw)
            spells = []
            for sp in result.get('spells', [])[:5]:
                if 'name' in sp and 'xp' in sp:
                    spells.append({
                        'name': str(sp['name'])[:80],
                        'description': str(sp.get('description', ''))[:120],
                        'xp': max(10, min(50, int(sp['xp']))),
                    })
            if spells:
                event_q.put(json.dumps({"school_end": {"idx": idx, "spells": spells}}))
            else:
                event_q.put(json.dumps({"err": f"No valid spells for {name}.", "idx": idx}))
        except Exception as e:
            log.warning('onboard parse error (school %s): %s | raw: %.200s', name, e, full_text)
            event_q.put(json.dumps({"err": f"Could not parse spells for {name}.", "idx": idx}))

        event_q.put(None)  # sentinel: this school finished

    @stream_with_context
    def generate():
        # Launch all schools in parallel threads
        for idx, school in enumerate(schools):
            t = threading.Thread(target=gen_school, args=(idx, school), daemon=True)
            t.start()

        done = 0
        while done < len(schools):
            try:
                item = event_q.get(timeout=130)
                if item is None:
                    done += 1
                else:
                    yield f'data: {item}\n\n'
            except Exception:
                break

        yield f'data: {json.dumps({"all_done": True})}\n\n'

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/onboard/commit', methods=['POST'])
@require_login_api
def api_onboard_commit():
    user_id = session['user_id']
    data = request.get_json()
    schools = data.get('schools', [])

    db = get_db()
    now = datetime.utcnow().isoformat()

    for sd in schools:
        name = (sd.get('name') or '').strip()
        flavour = (sd.get('flavour') or '').strip()
        color = sd.get('color') or '#c9a227'
        is_custom = 1 if sd.get('is_custom') else 0
        user_description = sd.get('user_description') or ''
        spells = sd.get('spells') or []

        if not name or not flavour:
            continue

        cur = db.execute(
            'INSERT INTO schools (user_id, name, flavour, is_custom, color, user_description, created_at) '
            'VALUES (?,?,?,?,?,?,?)',
            (user_id, name, flavour, is_custom, color, user_description, now),
        )
        school_id = cur.lastrowid

        for sp in spells[:5]:
            sp_name = str(sp.get('name') or '')[:80].strip()
            sp_desc = str(sp.get('description') or '')[:120].strip()
            sp_xp = max(10, min(50, int(sp.get('xp') or 20)))
            if sp_name:
                db.execute(
                    'INSERT INTO spells (school_id, name, description, xp) VALUES (?,?,?,?)',
                    (school_id, sp_name, sp_desc, sp_xp),
                )

        db.execute(
            'INSERT OR REPLACE INTO user_xp (user_id, school_id, xp) VALUES (?,?,0)',
            (user_id, school_id),
        )

    db.execute('UPDATE users SET onboarded=1 WHERE id=?', (user_id,))
    session.pop('onboarding_schools', None)
    db.commit()
    return jsonify({'ok': True})


# ── Main page ─────────────────────────────────────────────────────────────────

@app.route('/')
@require_login
def index():
    user_id = session['user_id']
    db = get_db()
    schools = get_user_schools(user_id)

    deed_log = db.execute(
        'SELECT dl.*, s.name as school_name, s.color as school_color '
        'FROM deed_log dl JOIN schools s ON s.id = dl.school_id '
        'WHERE dl.user_id = ? ORDER BY dl.cast_at DESC LIMIT 200',
        (user_id,),
    ).fetchall()
    deed_log = [dict(d) for d in deed_log]

    avg_level = round(sum(s['level'] for s in schools) / len(schools)) if schools else 1
    overall_rank = get_rank(avg_level)

    user_row = db.execute('SELECT ai_title, onboarded FROM users WHERE id=?', (user_id,)).fetchone()
    ai_title = user_row['ai_title'] if user_row and user_row['ai_title'] else compute_title(schools)
    needs_onboarding = not bool(user_row['onboarded']) if user_row else False

    default_schools_json = json.dumps([
        {'name': s['name'], 'flavour': s['flavour'], 'color': s['color']}
        for s in DEFAULT_SCHOOLS
    ])

    return render_template(
        'index.html',
        username=session['username'],
        schools=schools,
        ai_title=ai_title,
        avg_level=avg_level,
        overall_rank=overall_rank,
        ranks=RANKS,
        schools_json=json.dumps(schools),
        deed_log_json=json.dumps(deed_log),
        needs_onboarding=needs_onboarding,
        default_schools_json=default_schools_json,
    )


# ── API routes ────────────────────────────────────────────────────────────────

@app.route('/api/cast', methods=['POST'])
@require_login_api
def api_cast():
    user_id = session['user_id']
    data = request.get_json()
    spell_id = data.get('spell_id')

    db = get_db()
    spell = db.execute(
        'SELECT sp.*, s.user_id FROM spells sp '
        'JOIN schools s ON s.id = sp.school_id WHERE sp.id = ?',
        (spell_id,),
    ).fetchone()
    if not spell or spell['user_id'] != user_id:
        return jsonify({'error': 'Not found'}), 404

    result = build_xp_result(db, user_id, spell['school_id'], spell['xp'], spell['name'])
    return jsonify(result)


@app.route('/api/augur/deed', methods=['POST'])
@require_login_api
def api_augur_deed():
    user_id = session['user_id']
    data = request.get_json()
    school_id = data.get('school_id')
    deed = data.get('deed', '').strip()

    if not deed:
        return jsonify({'error': 'No deed provided'}), 400

    db = get_db()
    school = db.execute(
        'SELECT * FROM schools WHERE id=? AND user_id=?', (school_id, user_id)
    ).fetchone()
    if not school:
        return jsonify({'error': 'Not found'}), 404

    xp_row = db.execute(
        'SELECT xp FROM user_xp WHERE user_id=? AND school_id=?', (user_id, school_id)
    ).fetchone()
    current_xp = xp_row['xp'] if xp_row else 0
    level = get_level(current_xp)

    system = (
        'Augur: terse fantasy arbiter. 1-2 archaic sentences, never effusive. '
        'JSON only: {"xp":number,"verdict":"string"}. XP 5-50 by effort. No markdown.'
    )
    user_msg = (
        f'School: {school["name"]}, LV{level}. Deed: "{deed}". Judge and assign XP.'
    )

    result = call_augur(system, user_msg, num_predict=80, num_ctx=512)
    if not result or 'xp' not in result or 'verdict' not in result:
        return jsonify({'error': 'The Augur is silent. The ether is troubled.'}), 503

    result['xp'] = max(5, min(50, int(result['xp'])))
    return jsonify(result)


@app.route('/api/augur/accept', methods=['POST'])
@require_login_api
def api_augur_accept():
    user_id = session['user_id']
    data = request.get_json()
    school_id = data.get('school_id')
    deed = data.get('deed', '').strip()
    xp = int(data.get('xp', 0))
    verdict = data.get('verdict', '')

    db = get_db()
    school = db.execute(
        'SELECT * FROM schools WHERE id=? AND user_id=?', (school_id, user_id)
    ).fetchone()
    if not school:
        return jsonify({'error': 'Not found'}), 404

    result = build_xp_result(db, user_id, school_id, xp, deed, is_custom=True, verdict=verdict)
    return jsonify(result)


SCHOOL_HABIT_EXAMPLES = {
    'Restoration': '"Sleep 7-9 hours", "Drink 2 litres of water", "Eat fruits and vegetables", "Cook a healthy meal", "Take a nap", "Follow a sleep schedule"',
    'Transmutation': '"Complete a full workout", "Go for a 5km run", "Walk 8000 steps", "Do 20 minutes of stretching", "Complete 50 push-ups", "Cycle for 30 minutes"',
    'Divination': '"Meditate for 10 minutes", "Write in a journal for 10 minutes", "Spend 30 minutes in nature", "Practice 5 minutes of breathwork", "Do a gratitude list", "Spend time in silence"',
    'Artifice': '"Complete a 1-hour deep work session", "Read for 30 minutes", "Learn one new thing", "Finish a key task", "Study for 45 minutes", "Write 500 words"',
    'Enchantment': '"Have a meaningful conversation", "Reach out to a friend", "Spend quality time with someone", "Do something kind for another person", "Attend a social event", "Write a letter or message to someone"',
}


def _generate_recal_spells(school, context, db, user_id):
    """Generate recalibrated spells via AI. Returns list of spell dicts or None on failure."""
    school_id = school['id']
    deed_rows = db.execute(
        'SELECT deed_name FROM deed_log WHERE user_id=? AND school_id=? ORDER BY cast_at DESC LIMIT 20',
        (user_id, school_id),
    ).fetchall()
    freq = {}
    for row in deed_rows:
        freq[row['deed_name']] = freq.get(row['deed_name'], 0) + 1
    summary = ', '.join(f'"{k}" \xd7{v}' for k, v in freq.items()) or 'none yet'

    domain_examples = SCHOOL_HABIT_EXAMPLES.get(school['name'], '')
    if not domain_examples:
        # For custom schools, derive examples from the flavour text
        domain_examples = f'habits directly related to: {school["flavour"]}'

    system = (
        'You are the Augur — a dark fantasy sage calibrating a hero\'s training regimen. '
        'Return ONLY valid JSON: {"spells":[{"name":"string","description":"string","xp":number}]}. '
        '4-5 spells. '
        'These spells are habits the user logs RETROACTIVELY — they already did the thing and are recording it. '
        'Each spell must be something real a person would actually do and later recognise as done. '
        'RULE 1 — every spell must be a concrete, repeatable daily habit from the school\'s literal real-world domain. '
        'Do NOT invent tasks from the school\'s fantasy name, aesthetic, or flavour. '
        'A climbing school generates climbing and fitness habits. A cooking school generates cooking habits. Never cave imagery, never shadow metaphors. '
        'RULE 2 — "description" is ONE plain sentence: action + specific target. No fantasy language, no fluff. '
        'GOOD: "Walk 8,000 steps", "Do 20 push-ups", "Cook a meal from scratch", "Read for 30 minutes". '
        'BAD: "Commune with spirits", "Forge your will in shadow", "Seek visions in the abyss". '
        'RULE 3 — "name" is a short fantasy incantation title (2-4 words) wrapping the real-world task. This is the ONLY fantasy part. '
        'Mix: (A) Latin/mystical (e.g. "Somnium", "Hydor", "Ignis Vitae") or (B) fantasy patterns (e.g. "Hex of Fortitude", "Rite of Iron"). '
        'XP 10-50 scaled to effort. No markdown, no extra keys.'
    )
    user_msg = (
        f'SCHOOL: {school["name"].upper()}\n'
        f'Domain: {school["flavour"]}\n'
        f'Example habits for this school: {domain_examples}\n'
        f'Recent acts: {summary}.\n'
    )
    if context:
        user_msg += f'Seeker\'s guidance: "{context}"\n'
    user_msg += 'Vary habits to avoid repeating overused ones.'

    result = call_augur(system, user_msg, num_predict=320, temperature=0.4)
    if not result or 'spells' not in result or not result['spells']:
        return None

    spells = []
    for sp in result['spells'][:5]:
        if 'name' in sp and 'xp' in sp:
            spells.append({
                'name': str(sp['name'])[:80],
                'description': str(sp.get('description', ''))[:120],
                'xp': max(10, min(50, int(sp['xp']))),
            })
    return spells or None


def _save_recal_spells(db, school_id, spells):
    """Persist spell list to DB, returning spells with IDs."""
    db.execute('DELETE FROM spells WHERE school_id=?', (school_id,))
    new_spells = []
    for sp in spells:
        desc = sp.get('description', '') or ''
        cur = db.execute(
            'INSERT INTO spells (school_id, name, description, xp) VALUES (?,?,?,?)',
            (school_id, sp['name'], desc[:120], sp['xp']),
        )
        new_spells.append({
            'id': cur.lastrowid, 'name': sp['name'],
            'description': desc, 'xp': sp['xp'], 'school_id': school_id,
        })
    db.commit()
    return new_spells


@app.route('/api/augur/recalibrate', methods=['POST'])
@require_login_api
def api_augur_recalibrate():
    """Stream recalibrated spells via SSE — yields tokens then a final done event."""
    user_id = session['user_id']
    data = request.get_json()
    school_id = data.get('school_id')

    db = get_db()
    school = db.execute(
        'SELECT * FROM schools WHERE id=? AND user_id=?', (school_id, user_id)
    ).fetchone()
    if not school:
        return jsonify({'error': 'Not found'}), 404

    context = data.get('context', '').strip()
    school = dict(school)

    deed_rows = db.execute(
        'SELECT deed_name FROM deed_log WHERE user_id=? AND school_id=? ORDER BY cast_at DESC LIMIT 20',
        (user_id, school_id),
    ).fetchall()
    freq = {}
    for row in deed_rows:
        freq[row['deed_name']] = freq.get(row['deed_name'], 0) + 1
    summary = ', '.join(f'"{k}" \xd7{v}' for k, v in freq.items()) or 'none yet'

    domain_examples = SCHOOL_HABIT_EXAMPLES.get(school['name'], '')
    if not domain_examples:
        user_desc = (school.get('user_description') or '').strip()
        domain_examples = user_desc if user_desc else f'habits directly related to: {school["flavour"]}'

    system = (
        'Augur: calibrate hero habits. '
        'JSON only: {"spells":[{"name":"string","description":"string","xp":number}]}. '
        '4-5 spells, logged after completion. '
        'R1: concrete real-world habits from the domain — never fantasy imagery or flavour metaphors. '
        'R2: description = one plain sentence (e.g. "Walk 8000 steps", "Cook a meal from scratch"). '
        'R3: name = 2-4 word fantasy title only (e.g. "Rite of Iron", "Somnium Vitae"). '
        'XP 10-50 by effort. No markdown.'
    )
    user_msg = (
        f'School: {school["name"]}, domain: {school["flavour"]}.\n'
        f'Examples: {domain_examples}\n'
        f'Recent: {summary}.\n'
    )
    if context:
        user_msg += f'Guidance: "{context}"\n'
    user_msg += 'Vary to avoid repeats.'

    full_prompt = f'{system}\n\n{user_msg}'

    @stream_with_context
    def generate():
        full_text = ''
        try:
            resp = requests.post(OLLAMA_URL, json={
                'model': OLLAMA_MODEL,
                'prompt': full_prompt,
                'stream': True,
                'format': 'json',
                'options': {'temperature': 0.4, 'num_predict': 320, 'num_ctx': 1024},
            }, stream=True, timeout=90)
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                token = chunk.get('response', '')
                full_text += token
                yield f'data: {json.dumps({"t": token})}\n\n'
                if chunk.get('done'):
                    break
        except Exception as e:
            log.warning('recalibrate stream error: %s', e)
            yield f'data: {json.dumps({"err": "The Augur could not recalibrate at this time."})}\n\n'
            return

        try:
            raw = re.sub(r'```(?:json)?', '', full_text).strip('` \n')
            result = json.loads(raw)
            spells = []
            for sp in result.get('spells', [])[:5]:
                if 'name' in sp and 'xp' in sp:
                    spells.append({
                        'name': str(sp['name'])[:80],
                        'description': str(sp.get('description', ''))[:120],
                        'xp': max(10, min(50, int(sp['xp']))),
                    })
            if spells:
                yield f'data: {json.dumps({"done": True, "spells": spells})}\n\n'
            else:
                yield f'data: {json.dumps({"err": "The Augur could not recalibrate at this time."})}\n\n'
        except Exception as e:
            log.warning('recalibrate parse error: %s | raw: %.200s', e, full_text)
            yield f'data: {json.dumps({"err": "The Augur could not recalibrate at this time."})}\n\n'

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/augur/recalibrate/confirm', methods=['POST'])
@require_login_api
def api_augur_recalibrate_confirm():
    """Accept and save a previewed recalibration."""
    user_id = session['user_id']
    data = request.get_json()
    school_id = data.get('school_id')
    spells = data.get('spells', [])

    if not spells:
        return jsonify({'error': 'No spells provided'}), 400

    db = get_db()
    school = db.execute(
        'SELECT * FROM schools WHERE id=? AND user_id=?', (school_id, user_id)
    ).fetchone()
    if not school:
        return jsonify({'error': 'Not found'}), 404

    new_spells = _save_recal_spells(db, school_id, spells)
    return jsonify({'spells': new_spells})


@app.route('/api/augur/school', methods=['POST'])
@require_login_api
def api_augur_school():
    user_id = session['user_id']
    data = request.get_json()
    description = data.get('description', '').strip()

    if not description:
        return jsonify({'error': 'No description provided'}), 400

    system = (
        'You are the Augur — a dark fantasy sage who names and defines schools of arcane practice. '
        'Return ONLY valid JSON: {"name":"string","flavour":"string","spells":[{"name":"string","description":"string","xp":number}]}. '
        'School name: 1-2 evocative dark fantasy words (e.g. Umbramancy, Ironveil, Sanguine). '
        'Flavour: 1 concise sentence describing the school\'s domain. No purple prose. '
        '4-5 spells. These are habits the user logs RETROACTIVELY — they already did the thing and are recording it. '
        'Each spell must be something real a person would actually do and later recognise as done. '
        'For each spell: '
        'RULE 1 — "description" is ONE plain sentence: action + specific target, grounded in the literal real-world pursuit. '
        'GOOD: "Cook a meal from scratch", "Practice knife skills for 20 minutes", "Walk 8,000 steps". '
        'BAD: "Commune with the flame", "Forge your will in shadow", "Prepare a dish using fire". '
        'RULE 2 — "name" is a short fantasy incantation title (2-4 words) wrapping the real-world task. This is the ONLY fantasy part. '
        'Mix: (A) Latin/mystical (e.g. "Somnium", "Ignis", "Cibus Rite") or (B) fantasy patterns (e.g. "Hex of X", "Oath of X"). '
        'XP 10-50 scaled to effort. No markdown, no extra keys.'
    )
    user_msg = f'The seeker wishes to cultivate: "{description}"\nCreate a school of magic for this pursuit.'
    full_prompt = f'{system}\n\n{user_msg}'

    @stream_with_context
    def generate():
        full_text = ''
        try:
            resp = requests.post(OLLAMA_URL, json={
                'model': OLLAMA_MODEL,
                'prompt': full_prompt,
                'stream': True,
                'format': 'json',
                'options': {'temperature': 0.5, 'num_predict': 380, 'num_ctx': 1024},
            }, stream=True, timeout=90)
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                chunk = json.loads(line)
                token = chunk.get('response', '')
                full_text += token
                yield f'data: {json.dumps({"t": token})}\n\n'
                if chunk.get('done'):
                    break
        except Exception as e:
            log.warning('school stream error: %s', e)
            yield f'data: {json.dumps({"err": "The Augur could not conceive a school at this time."})}\n\n'
            return

        try:
            raw = re.sub(r'```(?:json)?', '', full_text).strip('` \n')
            result = json.loads(raw)
            if 'name' not in result or 'spells' not in result:
                raise ValueError('missing keys')
            spells = []
            for sp in result.get('spells', [])[:5]:
                if 'name' in sp and 'xp' in sp:
                    spells.append({
                        'name': str(sp['name'])[:80],
                        'description': str(sp.get('description', ''))[:120],
                        'xp': max(10, min(50, int(sp['xp']))),
                    })
            yield f'data: {json.dumps({"done": True, "name": str(result.get("name",""))[:50], "flavour": str(result.get("flavour",""))[:300], "spells": spells})}\n\n'
        except Exception as e:
            log.warning('school parse error: %s | raw: %.200s', e, full_text)
            yield f'data: {json.dumps({"err": "The Augur could not conceive a school at this time."})}\n\n'

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/augur/school/confirm', methods=['POST'])
@require_login_api
def api_augur_school_confirm():
    user_id = session['user_id']
    data = request.get_json()
    name = data.get('name', '').strip()
    flavour = data.get('flavour', '').strip()
    spells = data.get('spells', [])

    if not name or not spells:
        return jsonify({'error': 'Name and spells required'}), 400

    db = get_db()
    custom_count = db.execute(
        'SELECT COUNT(*) FROM schools WHERE user_id=? AND is_custom=1', (user_id,)
    ).fetchone()[0]
    color = CUSTOM_COLORS[custom_count % len(CUSTOM_COLORS)]

    user_description = data.get('user_description', '').strip()[:500]
    now = datetime.utcnow().isoformat()
    cur = db.execute(
        'INSERT INTO schools (user_id, name, flavour, is_custom, color, created_at, user_description) VALUES (?,?,?,1,?,?,?)',
        (user_id, name[:50], flavour[:300], color, now, user_description or None),
    )
    school_id = cur.lastrowid

    new_spells = []
    for sp in spells[:5]:
        if 'name' in sp and 'xp' in sp:
            sp_xp = max(10, min(50, int(sp['xp'])))
            sp_desc = str(sp.get('description', ''))[:120]
            sp_cur = db.execute(
                'INSERT INTO spells (school_id, name, description, xp) VALUES (?,?,?,?)',
                (school_id, str(sp['name'])[:80], sp_desc, sp_xp),
            )
            new_spells.append({'id': sp_cur.lastrowid, 'name': sp['name'], 'description': sp_desc, 'xp': sp_xp, 'school_id': school_id})

    db.execute('INSERT INTO user_xp (user_id, school_id, xp) VALUES (?,?,0)', (user_id, school_id))
    db.commit()

    rank = get_rank(1)
    return jsonify({
        'school': {
            'id': school_id,
            'name': name,
            'flavour': flavour,
            'is_custom': 1,
            'color': color,
            'total_xp': 0,
            'level': 1,
            'xp_in_level': 0,
            'rank': rank,
            'spells': new_spells,
        }
    })


# Titles per school per rank. Multiple options per rank; picked by dominant_level % len.
SCHOOL_TITLES = {
    'Restoration': {
        'F': ['Sickly Wretch',         'Hollow Vessel',         'Ailing Novice'],
        'E': ['Weary Mender',          'Faltering Healer',      'Fledgling Restorer'],
        'D': ['Apprentice Healer',     'Student of Restoration','Steadfast Novice'],
        'C': ['Practitioner of Restoration', 'Devoted Healer',  'Steadfast Restorer'],
        'B': ['Adept of Restoration',  'Seasoned Healer',       'Veteran Mender',    'Tried Restorer'],
        'A': ['Grand Restorer',        'Healer of the Weary',   'Iron-Willed Mender', 'Warden of Flesh'],
        'S': ['Master Healer',         'Undying Restorer',      'Eternal Mender',    'The Unbroken'],
    },
    'Transmutation': {
        'F': ['Soft-Bodied',           'Untempered',            'Untested Forger'],
        'E': ['Fumbling Shaper',       'Aspiring Forger',       'Fledgling Transmuter'],
        'D': ['Apprentice Forger',     'Student of Transmutation', 'Iron Novice'],
        'C': ['Practitioner of Transmutation', 'Iron Devotee',  'Steady Forger'],
        'B': ['Adept of Transmutation','Seasoned Forger',       'Veteran Shaper',    'Iron-Willed'],
        'A': ['Grand Transmuter',      'Forged in Discipline',  'Iron-Clad',         'Relentless Shaper'],
        'S': ['Master Transmuter',     'Unbreakable',           'Eternal Forger',    'The Reforged'],
    },
    'Divination': {
        'F': ['Clouded Mind',          'Murky Gazer',           'Unfocused'],
        'E': ['Clouded Seer',          'Fumbling Gazer',        'Fledgling Diviner'],
        'D': ['Apprentice Seer',       'Student of Divination', 'Seeking Gazer'],
        'C': ['Practitioner of Divination', 'Focused Seer',    'Clear-Eyed'],
        'B': ['Adept of Divination',   'Seasoned Gazer',        'Veteran Seer',      'Still-Minded'],
        'A': ['Grand Diviner',         'Far-Sighted',           'Keeper of Clarity', 'Watcher of Self'],
        'S': ['Master Diviner',        'All-Seeing',            'Eternal Seer',      'The Unfogged'],
    },
    'Artifice': {
        'F': ['Rough-Handed',          'Fumbling Craftsman',    'Unfinished Work'],
        'E': ['Clumsy Craftsman',      'Aspiring Artificer',    'Fledgling Maker'],
        'D': ['Apprentice Artificer',  'Student of Artifice',   'Steady Hand'],
        'C': ['Practitioner of Artifice', 'Reliable Craftsman', 'Devoted Artificer'],
        'B': ['Adept of Artifice',     'Seasoned Artificer',    'Veteran Craftsman', 'Methodical Maker'],
        'A': ['Grand Artificer',       'Architect of Habit',    'Rune-Carver',       'Deliberate Maker'],
        'S': ['Master Artificer',      'Living Rune',           'Eternal Craftsman', 'The Completed Work'],
    },
    'Enchantment': {
        'F': ['Unnoticed',             'Awkward Presence',      'Hollow Voice'],
        'E': ['Unbound Soul',          'Fumbling Binder',       'Fledgling Enchanter'],
        'D': ['Apprentice Enchanter',  'Student of Enchantment','Seeking Binder'],
        'C': ['Practitioner of Enchantment', 'Silver-Tongued', 'Devoted Enchanter'],
        'B': ['Adept of Enchantment',  'Seasoned Enchanter',    'Veteran Binder',    'Warm Presence'],
        'A': ['Grand Enchanter',       'Heart-Speaker',         'Keeper of Bonds',   'The Beloved'],
        'S': ['Master Enchanter',      'Soul-Weaver',           'Eternal Binder',    'The Unifying'],
    },
}

BALANCED_TITLES = {
    'F': ['Lost',                   'Directionless',          'Scattered',            'Unfocused',
          'Wandering',              'Unproven'],
    'E': ['Unproven Initiate',      'Wandering Apprentice',   'Aimless Seeker',       'Fumbling Student',
          'Curious Novice',         'Seeker of Many Things'],
    'D': ['Apprentice of the Arcane', 'Journeyman',           'Fledgling Mage',       'Student of All Trades',
          'Earnest Learner',        'Dabbler of Many Arts'],
    'C': ['Arcane Practitioner',    'Journeyman Mage',        'Well-Rounded Scholar', 'Keeper of Many Rites',
          'Steady Hand',            'Devoted Generalist',     'Balanced Seeker'],
    'B': ['Arcane Adept',           'Skilled Mage',           'Seasoned Scholar',     'Versatile Adept',
          'Many-Pathed',            'Scholar of Many Schools','Keeper of Balance'],
    'A': ['Grand Scholar',          'Arcane Veteran',         'Keeper of Many Arts',  'The Versatile',
          'Boundless Seeker',       'Scholar of All Paths',   'The Well-Rounded'],
    'S': ['Master of the Arcane',   'Archmage',               'Grand Mage',           'The Boundless',
          'Eternal Scholar',        'The Unspecialised',      'Master of All Rites'],
}

CUSTOM_SCHOOL_TITLES = {
    'F': ['Lost in {name}',           'Fumbling {name} Novice',    'Unproven in {name}',       'Stumbling Seeker'],
    'E': ['Fledgling {name} Seeker',  'Wanderer of {name}',        'Aspiring {name} Student',  'Initiate of {name}'],
    'D': ['Apprentice of {name}',     'Student of {name}',         'Earnest {name} Learner',   'Devoted {name} Novice'],
    'C': ['Practitioner of {name}',   'Devotee of {name}',         '{name} Journeyman',        'Steady {name} Scholar'],
    'B': ['Adept of {name}',          'Veteran of {name}',         '{name} Specialist',        'Seasoned {name} Seeker'],
    'A': ['Scholar of {name}',        'Grand {name} Scholar',      'Distinguished {name} Adept', '{name} Expert'],
    'S': ['Master of {name}',         'Eternal Sage of {name}',    'Grand Master of {name}',   'Undying {name} Scholar'],
}


def compute_title(schools):
    if not schools:
        return 'Unproven Initiate'

    def pick(options, level):
        return options[level % len(options)] if isinstance(options, list) else options

    # Single school — always specialised
    if len(schools) == 1:
        s = schools[0]
        rank = get_rank(s['level'])['name']
        name = s['name']
        if name in SCHOOL_TITLES:
            return pick(SCHOOL_TITLES[name].get(rank, [f'Initiate of {name}']), s['level'])
        template = pick(CUSTOM_SCHOOL_TITLES.get(rank, ['Initiate of {name}']), s['level'])
        return template.format(name=name)

    dominant = max(schools, key=lambda s: s['level'])
    dom_level = dominant['level']
    rank = get_rank(dom_level)['name']

    # Specialised: one school is uniquely the highest AND at least 2 levels above all others
    others = [s for s in schools if s['id'] != dominant['id']]
    second_highest = max(s['level'] for s in others)
    is_specialised = dom_level - second_highest >= 2

    if not is_specialised:
        return pick(BALANCED_TITLES.get(rank, ['Arcane Practitioner']), dom_level)

    name = dominant['name']
    if name in SCHOOL_TITLES:
        return pick(SCHOOL_TITLES[name].get(rank, [f'Initiate of {name}']), dom_level)
    template = pick(CUSTOM_SCHOOL_TITLES.get(rank, ['Initiate of {name}']), dom_level)
    return template.format(name=name)


@app.route('/api/augur/warmup', methods=['POST'])
@require_login_api
def api_augur_warmup():
    """Fire a minimal prompt to keep the model loaded in memory indefinitely."""
    try:
        requests.post(OLLAMA_URL, json={
            'model': OLLAMA_MODEL,
            'prompt': 'Reply with valid JSON: {"ok":true}',
            'stream': False,
            'format': 'json',
            'keep_alive': -1,
            'options': {'num_predict': 8},
        }, timeout=120)
    except Exception as e:
        log.info('warmup: %s', e)
    return jsonify({'ok': True})


@app.route('/api/augur/title', methods=['POST'])
@require_login_api
def api_augur_title():
    user_id = session['user_id']
    db = get_db()
    schools = get_user_schools(user_id)
    if not schools:
        return jsonify({'error': 'No schools found'}), 400

    title = compute_title(schools)
    user_row = db.execute('SELECT ai_title FROM users WHERE id=?', (user_id,)).fetchone()
    old_title = user_row['ai_title'] if user_row else None
    db.execute('UPDATE users SET ai_title=? WHERE id=?', (title, user_id))
    if title != old_title:
        record_milestone(db, user_id, 'title', f'Title bestowed: {title}')
    db.commit()
    return jsonify({'title': title})


@app.route('/api/school/<int:school_id>', methods=['DELETE'])
@require_login_api
def api_delete_school(school_id):
    user_id = session['user_id']
    db = get_db()
    school = db.execute(
        'SELECT * FROM schools WHERE id=? AND user_id=? AND is_custom=1',
        (school_id, user_id),
    ).fetchone()
    if not school:
        return jsonify({'error': 'Not found or not a custom school'}), 404

    db.execute('DELETE FROM schools WHERE id=?', (school_id,))
    db.commit()
    return jsonify({'ok': True})


# ── Chronicle calendar ───────────────────────────────────────────────────────

@app.route('/api/chronicle/calendar', methods=['POST'])
@require_login_api
def api_chronicle_calendar():
    user_id = session['user_id']
    data = request.get_json() or {}
    days = int(data.get('days', 90))
    days = min(days, 365)

    db = get_db()
    since = (datetime.utcnow() - timedelta(days=days)).date().isoformat()

    rows = db.execute(
        'SELECT dl.cast_at, dl.xp, dl.deed_name, dl.is_custom, '
        '       s.name as school_name, s.color as school_color '
        'FROM deed_log dl JOIN schools s ON s.id = dl.school_id '
        'WHERE dl.user_id = ? AND dl.cast_at >= ? '
        'ORDER BY dl.cast_at ASC',
        (user_id, since),
    ).fetchall()

    # Aggregate by date
    from collections import defaultdict
    days_map = defaultdict(lambda: {'xp': 0, 'count': 0, 'schools': {}, 'deeds': []})
    for row in rows:
        date = row['cast_at'][:10]
        d = days_map[date]
        d['xp'] += row['xp']
        d['count'] += 1
        d['deeds'].append({
            'deed_name': row['deed_name'],
            'school_name': row['school_name'],
            'school_color': row['school_color'],
            'xp': row['xp'],
            'is_custom': row['is_custom'],
        })
        # Track XP per school active that day
        if row['school_name'] not in d['schools']:
            d['schools'][row['school_name']] = {'color': row['school_color'], 'xp': 0}
        d['schools'][row['school_name']]['xp'] += row['xp']

    # Convert schools dict to list for JSON
    result = {}
    for date, d in days_map.items():
        result[date] = {
            'xp': d['xp'],
            'count': d['count'],
            'schools': [{'name': k, 'color': v['color'], 'xp': v['xp']} for k, v in d['schools'].items()],
            'deeds': d['deeds'],
        }

    return jsonify(result)


# ── Chronicle milestones ─────────────────────────────────────────────────────

@app.route('/api/chronicle/milestones', methods=['POST'])
@require_login_api
def api_chronicle_milestones():
    user_id = session['user_id']
    db = get_db()
    rows = db.execute(
        'SELECT m.id, m.type, m.description, m.occurred_at, s.color as school_color '
        'FROM milestones m LEFT JOIN schools s ON s.id = m.school_id '
        'WHERE m.user_id = ? ORDER BY m.occurred_at DESC',
        (user_id,),
    ).fetchall()
    return jsonify([{
        'id':           r['id'],
        'type':         r['type'],
        'description':  r['description'],
        'occurred_at':  r['occurred_at'],
        'school_color': r['school_color'],
    } for r in rows])


# ── Edit school / spells ─────────────────────────────────────────────────────

@app.route('/api/school/<int:school_id>', methods=['PUT'])
@require_login_api
def api_school_edit(school_id):
    user_id = session['user_id']
    data = request.get_json()
    name = (data.get('name') or '').strip()[:50]
    flavour = (data.get('flavour') or '').strip()[:300]
    user_description = (data.get('user_description') or '').strip()[:500]
    color = (data.get('color') or '').strip()
    if not name:
        return jsonify({'error': 'Name required'}), 400
    import re
    if not re.match(r'^#[0-9a-fA-F]{6}$', color):
        color = None  # ignore invalid colour values
    db = get_db()
    school = db.execute(
        'SELECT * FROM schools WHERE id=? AND user_id=?', (school_id, user_id)
    ).fetchone()
    if not school:
        return jsonify({'error': 'Not found'}), 404
    if color:
        db.execute('UPDATE schools SET name=?, flavour=?, color=?, user_description=? WHERE id=?',
                   (name, flavour, color, user_description or None, school_id))
    else:
        db.execute('UPDATE schools SET name=?, flavour=?, user_description=? WHERE id=?',
                   (name, flavour, user_description or None, school_id))
    db.commit()
    effective_color = color or school['color']
    return jsonify({'id': school_id, 'name': name, 'flavour': flavour,
                    'color': effective_color, 'user_description': user_description})


@app.route('/api/school/<int:school_id>/spell', methods=['POST'])
@require_login_api
def api_spell_add(school_id):
    user_id = session['user_id']
    data = request.get_json()
    name = (data.get('name') or '').strip()[:80]
    description = (data.get('description') or '').strip()[:120]
    xp = max(10, min(50, int(data.get('xp') or 20)))
    if not name:
        return jsonify({'error': 'Name required'}), 400
    db = get_db()
    school = db.execute(
        'SELECT * FROM schools WHERE id=? AND user_id=?', (school_id, user_id)
    ).fetchone()
    if not school:
        return jsonify({'error': 'Not found'}), 404
    cur = db.execute(
        'INSERT INTO spells (school_id, name, description, xp) VALUES (?,?,?,?)',
        (school_id, name, description, xp),
    )
    db.commit()
    return jsonify({'id': cur.lastrowid, 'name': name, 'description': description, 'xp': xp, 'school_id': school_id})


@app.route('/api/spell/<int:spell_id>', methods=['PUT'])
@require_login_api
def api_spell_edit(spell_id):
    user_id = session['user_id']
    data = request.get_json()
    name = (data.get('name') or '').strip()[:80]
    description = (data.get('description') or '').strip()[:120]
    xp = max(10, min(50, int(data.get('xp') or 20)))
    if not name:
        return jsonify({'error': 'Name required'}), 400
    db = get_db()
    spell = db.execute(
        'SELECT sp.* FROM spells sp JOIN schools sc ON sp.school_id=sc.id '
        'WHERE sp.id=? AND sc.user_id=?', (spell_id, user_id)
    ).fetchone()
    if not spell:
        return jsonify({'error': 'Not found'}), 404
    db.execute('UPDATE spells SET name=?, description=?, xp=? WHERE id=?', (name, description, xp, spell_id))
    db.commit()
    return jsonify({'id': spell_id, 'name': name, 'description': description, 'xp': xp})


@app.route('/api/spell/<int:spell_id>', methods=['DELETE'])
@require_login_api
def api_spell_delete(spell_id):
    user_id = session['user_id']
    db = get_db()
    spell = db.execute(
        'SELECT sp.* FROM spells sp JOIN schools sc ON sp.school_id=sc.id '
        'WHERE sp.id=? AND sc.user_id=?', (spell_id, user_id)
    ).fetchone()
    if not spell:
        return jsonify({'error': 'Not found'}), 404
    db.execute('DELETE FROM spells WHERE id=?', (spell_id,))
    db.commit()
    return jsonify({'ok': True})


# ── Init & run ────────────────────────────────────────────────────────────────

init_db()

# Migrate existing DBs that predate added columns
try:
    _mig = sqlite3.connect(DATABASE)
    _mig.execute('ALTER TABLE users ADD COLUMN ai_title TEXT')
    _mig.execute('ALTER TABLE spells ADD COLUMN description TEXT NOT NULL DEFAULT \'\'')
    _mig.commit()
    _mig.close()
except Exception:
    pass

# Migrate existing DBs that predate the spells.description column
try:
    _mig = sqlite3.connect(DATABASE)
    _mig.execute("ALTER TABLE spells ADD COLUMN description TEXT NOT NULL DEFAULT ''")
    _mig.commit()
    _mig.close()
except Exception:
    pass

# Migrate existing DBs that predate the schools.user_description column
try:
    _mig = sqlite3.connect(DATABASE)
    _mig.execute("ALTER TABLE schools ADD COLUMN user_description TEXT")
    _mig.commit()
    _mig.close()
except Exception:
    pass

# Migrate existing DBs: add onboarded flag; mark users who already have schools as done
try:
    _mig = sqlite3.connect(DATABASE)
    _mig.execute("ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0")
    _mig.execute(
        "UPDATE users SET onboarded=1 WHERE id IN (SELECT DISTINCT user_id FROM schools)"
    )
    _mig.commit()
    _mig.close()
except Exception:
    pass

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5009, debug=False)
