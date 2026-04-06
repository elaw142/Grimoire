# Grimoire

A fantasy-themed habit tracker that turns personal development into an RPG. You earn XP, level up, and unlock ranks by completing real-world tasks — judged by an AI oracle called the Augur.

![Dark fantasy aesthetic with animated splash screen, school cards, and XP system](https://placeholder)

---

## What it is

Grimoire organises your habits into **Schools of Magic** — each school maps to a real-world domain. You complete **deeds** (tasks) within each school to earn XP and level up. An on-device AI (the Augur) verifies your work and awards XP based on the effort involved.

**Default schools:**

| School | Domain |
|---|---|
| Restoration | Sleep, nutrition, recovery |
| Transmutation | Fitness, movement, exercise |
| Divination | Mindfulness, journaling, reflection |
| Artifice | Deep work, learning, writing |
| Enchantment | Relationships, socialising, connection |

You can also create custom schools for anything else — cooking, climbing, language learning, etc.

---

## Features

- **XP & levelling** — 100 XP per level, 7 ranks (F → E → D → C → B → A → S)
- **The Augur** — local LLM (Ollama + Mistral 7B) that judges deeds, generates spell lists, and creates custom schools from a description
- **Spells** — curated or AI-generated habits within each school; each has an XP value
- **Chronicle** — activity log, GitHub-style XP heatmap (90/180/365 day views), and milestone history
- **AI title** — the Augur generates a personalised character title based on your overall progression
- **Splash screen** — animated sigil draw-in on first load
- **Custom cursor** — gold dot with lagging ring
- **Particle canvas** — ambient background effects
- **PWA-ready** — installable on mobile

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3, Flask 3 |
| Database | SQLite (WAL mode) |
| Auth | bcrypt |
| AI | Ollama (local) + Mistral 7B |
| Frontend | Vanilla JS, CSS, Jinja2 templates |
| Fonts | Cinzel, Crimson Text (Google Fonts) |
| Production | Gunicorn, systemd, GitHub Actions |

---

## Prerequisites

- Python 3.11+
- [Ollama](https://ollama.com) running locally with the Mistral 7B model pulled:
  ```
  ollama pull mistral:7b
  ```

---

## Running locally

```bash
# 1. Clone and install dependencies
git clone https://github.com/elaw142/Grimoire
cd Grimoire
pip install -r requirements.txt

# 2. Start Ollama (in a separate terminal)
ollama serve

# 3. Run the app
python app.py
```

Visit `http://localhost:5009`.

The SQLite database (`grimoire.db`) is created automatically on first run.

---

## Configuration

Two optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | `dev-secret` | Flask session secret — **set this in production** |
| `OLLAMA_URL` | `http://localhost:11434/api/generate` | Ollama API endpoint |
| `OLLAMA_MODEL` | `mistral:7b` | Model to use for the Augur |

For production, set `SECRET_KEY` to a long random string. Everything else can stay default for a local Ollama setup.

---

## Project structure

```
Grimoire/
├── app.py                  — Flask app, routes, DB schema, AI calls
├── requirements.txt
├── grimoire.service        — systemd service for Linux deployment
├── .github/
│   └── workflows/
│       └── deploy.yml      — Auto-deploy on push to main
├── templates/
│   ├── base.html           — Base layout (particle canvas, fonts)
│   ├── index.html          — Main dashboard
│   ├── login.html
│   └── signup.html
└── static/
    ├── app.js              — All frontend logic and state
    ├── style.css           — Theming, animations, responsive layout
    ├── cursor.js           — Custom cursor
    ├── particles.js        — Canvas particle effects
    └── manifest.json       — PWA manifest
```

---

## Deploying to a server

The repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that deploys on every push to `main` via SSH. Set these secrets in your GitHub repo:

- `SSH_HOST` — server IP or hostname
- `SSH_USER` — SSH user
- `SSH_KEY` — private SSH key

On the server, Grimoire runs under Gunicorn managed by systemd. Copy `grimoire.service` to `/etc/systemd/system/`, set your `SECRET_KEY` in the service environment, and enable it:

```bash
sudo systemctl enable grimoire
sudo systemctl start grimoire
```

Put nginx or Caddy in front of it for HTTPS.

---

## How the Augur works

The Augur is a locally-running Mistral 7B model accessed via Ollama. It handles three tasks:

1. **Deed judgement** — when you log a custom deed, the Augur reads your school, level, and what you did, then returns a verdict and an XP award (5–50)
2. **Recalibration** — on rank-up, or on demand in the Augur tab, it generates a fresh set of 4–5 spells tailored to your recent activity history and any guidance you give it
3. **School creation** — describe a pursuit in plain text and the Augur generates a school name, flavour, and starting spell list

All Augur calls use short prompts and constrained context windows to keep response times low. Spell generation streams tokens back in real time so you can see names appear as the model generates them.

---

## Rank thresholds

| Rank | Min level |
|---|---|
| F | 1 |
| E | 5 |
| D | 10 |
| C | 15 |
| B | 20 |
| A | 25 |
| S | 30 |
