import sqlite3
import json
import logging
import os
import re
from datetime import datetime
from functools import wraps
from flask import Flask, render_template, request, session, redirect, url_for, jsonify, g
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
            {'name': 'Slept 7\u20139 hours', 'xp': 30},
            {'name': 'Consistent sleep schedule', 'xp': 25},
            {'name': 'Drank 2L+ of water', 'xp': 25},
            {'name': 'Ate fruits or vegetables', 'xp': 20},
            {'name': 'Cooked a healthy meal', 'xp': 25},
        ],
    },
    {
        'name': 'Transmutation',
        'flavour': 'To reshape the body is to defy entropy. Pain is the price; transformation, the reward.',
        'color': '#c9a227',
        'spells': [
            {'name': 'Full workout session', 'xp': 35},
            {'name': 'Went for a run', 'xp': 25},
            {'name': 'Walked 8,000+ steps', 'xp': 20},
            {'name': 'Stretched or did yoga', 'xp': 15},
        ],
    },
    {
        'name': 'Divination',
        'flavour': 'The mind is a mirror; left unpolished, it shows only shadow. Tend it with discipline.',
        'color': '#52b788',
        'spells': [
            {'name': 'Meditated', 'xp': 25},
            {'name': 'Journaled', 'xp': 20},
            {'name': 'Spent time in nature', 'xp': 20},
            {'name': 'Practiced gratitude', 'xp': 15},
        ],
    },
    {
        'name': 'Artifice',
        'flavour': 'Craft and knowledge are power made manifest. Every completed work is a rune carved into the world.',
        'color': '#74b9e0',
        'spells': [
            {'name': 'Deep work session (1h+)', 'xp': 30},
            {'name': 'Read for 20+ min', 'xp': 20},
            {'name': 'Learned something new', 'xp': 25},
            {'name': 'Completed a key task', 'xp': 20},
        ],
    },
    {
        'name': 'Enchantment',
        'flavour': 'The subtle art of binding souls \u2014 through word, deed, and genuine presence.',
        'color': '#d98fb0',
        'spells': [
            {'name': 'Meaningful conversation', 'xp': 25},
            {'name': 'Reached out to someone', 'xp': 20},
            {'name': 'Quality time with others', 'xp': 25},
            {'name': 'Did something kind', 'xp': 15},
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


def call_augur(system_prompt, user_prompt, num_predict=400, retries=1, temperature=0.5):
    full_prompt = f"{system_prompt}\n\n{user_prompt}"
    for attempt in range(retries + 1):
        try:
            resp = requests.post(OLLAMA_URL, json={
                'model': OLLAMA_MODEL,
                'prompt': full_prompt,
                'stream': False,
                'format': 'json',
                'options': {'temperature': temperature, 'num_predict': num_predict},
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
                'INSERT INTO spells (school_id, name, xp) VALUES (?,?,?)',
                (school_id, sp['name'], sp['xp']),
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
                provision_user_schools(user_id, db)
                session['user_id'] = user_id
                session['username'] = username
                return redirect(url_for('index'))
    return render_template('signup.html', error=error)


@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('login'))


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
        'WHERE dl.user_id = ? ORDER BY dl.cast_at DESC LIMIT 20',
        (user_id,),
    ).fetchall()
    deed_log = [dict(d) for d in deed_log]

    avg_level = round(sum(s['level'] for s in schools) / len(schools)) if schools else 1
    overall_rank = get_rank(avg_level)

    user_row = db.execute('SELECT ai_title FROM users WHERE id=?', (user_id,)).fetchone()
    ai_title = user_row['ai_title'] if user_row and user_row['ai_title'] else compute_title(schools)

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
        'You are the Augur \u2014 a deadpan fantasy arbiter of mortal effort. '
        'Speak in 1\u20132 terse archaic sentences. Never encouraging, never effusive. '
        'Return ONLY valid JSON: {"xp":number,"verdict":"string"}. '
        'XP 5\u201350 scaled to effort at this level. No markdown, no extra keys.'
    )
    user_msg = (
        f'School: {school["name"]}, Level {level}.\n'
        f'The seeker claims: "{deed}"\n'
        'Judge this deed and assign XP.'
    )

    result = call_augur(system, user_msg, num_predict=80)
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

    result = call_augur(system, user_msg, num_predict=550, temperature=0.4)
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
    """Preview recalibrated spells without saving — returns proposed spells for user to accept/deny."""
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

    spells = _generate_recal_spells(dict(school), context, db, user_id)
    if not spells:
        return jsonify({'error': 'The Augur could not recalibrate at this time.'}), 503

    return jsonify({'spells': spells})


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

    result = call_augur(system, user_msg, num_predict=500)
    if not result or 'name' not in result or 'spells' not in result:
        return jsonify({'error': 'The Augur could not conceive a school at this time.'}), 503

    spells = []
    for sp in result.get('spells', [])[:5]:
        if 'name' in sp and 'xp' in sp:
            spells.append({
                'name': str(sp['name'])[:80],
                'description': str(sp.get('description', ''))[:120],
                'xp': max(10, min(50, int(sp['xp']))),
            })

    return jsonify({
        'name': str(result.get('name', ''))[:50],
        'flavour': str(result.get('flavour', ''))[:300],
        'spells': spells,
    })


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

    now = datetime.utcnow().isoformat()
    cur = db.execute(
        'INSERT INTO schools (user_id, name, flavour, is_custom, color, created_at) VALUES (?,?,?,1,?,?)',
        (user_id, name[:50], flavour[:300], color, now),
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


# Titles per school per rank. Custom schools fall back to generic track.
SCHOOL_TITLES = {
    'Restoration': {
        'F': 'Weary Mender',       'E': 'Initiate of Restoration',
        'D': 'Apprentice Healer',  'C': 'Practitioner of Restoration',
        'B': 'Adept of Restoration', 'A': 'Master Healer',
        'S': 'Sovereign of Restoration',
    },
    'Transmutation': {
        'F': 'Untested Forger',    'E': 'Initiate of Transmutation',
        'D': 'Apprentice Forger',  'C': 'Practitioner of Transmutation',
        'B': 'Adept of Transmutation', 'A': 'Master Transmuter',
        'S': 'Sovereign of Transmutation',
    },
    'Divination': {
        'F': 'Clouded Seer',       'E': 'Initiate of Divination',
        'D': 'Apprentice Seer',    'C': 'Practitioner of Divination',
        'B': 'Adept of Divination', 'A': 'Master Diviner',
        'S': 'Sovereign of Divination',
    },
    'Artifice': {
        'F': 'Rough Craftsman',    'E': 'Initiate of Artifice',
        'D': 'Apprentice Artificer', 'C': 'Practitioner of Artifice',
        'B': 'Adept of Artifice',  'A': 'Master Artificer',
        'S': 'Sovereign of Artifice',
    },
    'Enchantment': {
        'F': 'Unbound Soul',       'E': 'Initiate of Enchantment',
        'D': 'Apprentice Enchanter', 'C': 'Practitioner of Enchantment',
        'B': 'Adept of Enchantment', 'A': 'Master Enchanter',
        'S': 'Sovereign of Enchantment',
    },
}

# Generic titles for custom schools or well-rounded characters
BALANCED_TITLES = {
    'F': 'Unproven Initiate',   'E': 'Apprentice of the Arcane',
    'D': 'Journeyman Mage',     'C': 'Arcane Practitioner',
    'B': 'Arcane Adept',        'A': 'Master of the Arcane',
    'S': 'Archmage',
}

CUSTOM_SCHOOL_TITLES = {
    'F': 'Fledgling Initiate',  'E': 'Initiate of {name}',
    'D': 'Apprentice of {name}', 'C': 'Practitioner of {name}',
    'B': 'Adept of {name}',     'A': 'Master of {name}',
    'S': 'Sovereign of {name}',
}


def compute_title(schools):
    if not schools:
        return 'Unproven Initiate'
    dominant = max(schools, key=lambda s: s['level'])
    others = [s for s in schools if s['id'] != dominant['id']]
    avg_others_level = round(sum(s['level'] for s in others) / len(others)) if others else dominant['level']
    is_specialised = get_rank(dominant['level'])['name'] != get_rank(avg_others_level)['name']
    overall_rank = get_rank(round(sum(s['level'] for s in schools) / len(schools)))['name']

    if not is_specialised:
        return BALANCED_TITLES.get(overall_rank, 'Arcane Practitioner')

    rank = dominant['rank']['name']
    name = dominant['name']
    if name in SCHOOL_TITLES:
        return SCHOOL_TITLES[name].get(rank, f'Initiate of {name}')
    # Custom school
    template = CUSTOM_SCHOOL_TITLES.get(rank, 'Initiate of {name}')
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
    db.execute('UPDATE users SET ai_title=? WHERE id=?', (title, user_id))
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


# ── Init & run ────────────────────────────────────────────────────────────────

init_db()

# Migrate existing DBs that predate the ai_title column
try:
    _mig = sqlite3.connect(DATABASE)
    _mig.execute('ALTER TABLE users ADD COLUMN ai_title TEXT')
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

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5009, debug=False)
