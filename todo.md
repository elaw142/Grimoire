# 🧙‍♂️ Grimoire — Task Board

---

## 🔮 Core Feature Enhancements

### 1. New User Experience (Augur Flow)
- Replace current predetermined starting tasks
- Introduce an **Augur-guided onboarding flow**:
  - The Augur asks the user questions to personalise their starting setup
  - Output should still resemble current default tasks structurally, be tailored to the user, and include magic-themed task names
- Goals: increase engagement, add personalisation, maintain usability

---

### 2. Rework Tasks / Spells Philosophy
- Core focus should be **consistent daily habits** (these are the primary spells)
- **Infrequent / one-off tasks** should be submitted through the Augur (custom deed)
- This shifts the system away from grinding and toward genuine habit building

---

### 3. Add / Edit Tasks
- Allow users to **add a specific task** to a school manually (without AI)
- Allow users to **edit the name and description** of existing tasks
- Allow users to **edit school name and flavour text**

---

### 4. Recalibration — Rethink
- Current rank-up auto-recalibration is complex and may be causing more friction than value
- **Consider removing rank-up recalibration entirely**
- If kept, simplify significantly — recalibration should feel like a light nudge, not a disruptive event
- Manual recalibration in the Augur tab can remain as an optional power-user feature

---

## ⚡ Performance

### 5. Improve AI Response Speed
- Investigate and optimise AI latency further
- Reduce blocking calls where possible
- Consider streaming or partial responses

---

### 6. UI Performance / Animation Fixes
- Fix low FPS / stuttering on hamburger menu open/close animation and school drawer open
- **Animations work fine on Mac — diagnose why they are inconsistent on other devices**
- Add smooth closing animation to hamburger menu

---

## 🎨 Visual / UI Polish

### 7. Graphics & Animations
- Add a **splash screen / loading animation** on initial page load
- Add **subtle particle effects** throughout the UI (ambient, not distracting)
- Ensure all animations are tasteful and performance-friendly

---

### 8. Orrery Text Overflow (iPhone SE)
- Fix school names being cut off on small screens
- Ensure responsive scaling for small screens

---

## 📜 Content & Tone

### 9. School Content Quality
- **Tone down school flavour text** — keep it flavourful but concise (1 sentence ideally)
- **Make task descriptions concise** — no fluff, one plain sentence, e.g. "Walk 8,000 steps"
- **Ensure school domain stays grounded in reality** — a bouldering school should generate climbing/fitness habits, not cave-themed fantasy tasks
- Review and tighten the AI prompts that govern these

---

### 10. Title System Improvements
- **Check and update title on every level-up** (not just rank changes)
- **Rename the tier structure** — F tier name feels too harsh as a starting point; shift names up one so the entry tier feels more welcoming
- Remove the Sovereign tier or replace it with something more fitting
- Expand the pool of title options for variety (more name options per school/rank combination)

---

### 11. Augur UI Improvements
- Add a **dropdown for options/settings within the Augur tab** (e.g. context, school selection)
- Add **flavour text for the Discover New School** loading state (similar to recalibration)

---

## 📅 New Features

### 12. Calendar / Timeline System
- Implement a **habit consistency tracking system**
- Rework or extend the Chronicle tab to show:
  - Activity over time (calendar or timeline view)
  - Consistency patterns and streaks
  - Visually intuitive layout

---

### 13. New User Tutorial / Walkthrough
- Add skippable onboarding tutorial for new users explaining:
  - Schools, Spells (tasks), Grimoire logging
- Should be interactive where possible and thematically consistent

---

### 14. Better Account Management
- Improve account settings (password change, username, profile)
- Ensure account-related flows are polished and on-theme

---

## 🐛 Known Issues / Bugs

### 15. Immersive Error Handling ✅
- Browser alert() popups replaced with themed toast and confirm dialog

### 16. AI Cold Start ✅
- Model kept loaded in memory via keep_alive: -1 and 4-minute heartbeat

---

## 🧩 Notes
- Maintain consistent magical/themed language across all features
- Prioritise **performance + immersion**
- Ensure all AI-generated content remains useful, actionable, and thematically aligned
