# 🧙‍♂️ AI Agent Implementation Tasks (Grimoire System)

## 🔮 Core Feature Enhancements

### 1. New User Experience (Augur Flow)

- Replace current predetermined starting tasks.
- Introduce an **Augur-guided onboarding flow**:
  - The Augur asks the user questions to personalise their starting setup.
  - The output should:
    - Still resemble current default tasks structurally
    - Be tailored to the user
    - Include **magic-themed task names**
- Goals:
  - Increase engagement
  - Add personalisation
  - Maintain usability

---

## ⚡ Performance Improvements

### 6. Improve AI Response Speed

- Investigate and optimise AI latency:
  - Reduce blocking calls where possible
  - Cache repeatable outputs
  - Consider streaming or partial responses
- Goal: noticeably faster interactions.

---

### 7. UI Performance Fixes

#### Hamburger Menu

- Fix low FPS / stuttering animation
- Add smooth **closing animation**

#### School Opening

- Fix low FPS / stuttering when opening a school view

---

## 📱 UI/UX Fixes & Improvements

### 8. Orrery Text Overflow (iPhone SE)

- Fix issue where school names are cut off
- Ensure responsive scaling for small screens

---

## 📜 New Features

### 10. Calendar / Timeline System

- Implement a **habit consistency tracking system**
- Options:
  - Rework the existing _Chronicle_ tab
  - Add a sub-view within Chronicle
  - Or create a new dedicated tab
- Should:
  - Show activity over time
  - Highlight consistency patterns
  - Be visually intuitive (calendar or timeline view)

---

### 11. Immersive Error Handling

- Dont use default browser pop up error messages
- Keep **themed error states**, e.g.:
  - "The Augur's vision fades… try again shortly."
- Requirements:
  - Maintain immersion
  - Provide clear retry paths

---

### 12. New User Tutorial / Walkthrough

- Add onboarding tutorial for new users:
  - Explain core concepts:
    - Schools
    - Spells (tasks)
    - Grimoire logging
  - Should be:
    - Skippable
    - Interactive where possible
    - Thematically consistent

---

## 🧩 Notes

- Maintain consistent magical/themed language across all features
- Prioritise **performance + immersion**
- Ensure all AI-generated content remains:
  - Useful
  - Actionable
  - Thematically aligned
