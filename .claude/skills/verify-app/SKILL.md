---
name: verify-app
description: Verify a change to the radar app end-to-end - lint, production build, and a smoke-test checklist for the running app (animation, split-screen, probe, interpolation). Use before pushing any nontrivial change to src/ or assets/.
---

# Verify a change to tutka.meteo.fi

Run these steps in order. Stop and fix at the first failure — do not push with any step red.

## 1. Static checks

```bash
npx eslint src/        # must exit 0 with no output
npm run build          # must complete without errors
ls -lh dist/*.js       # sanity: bundle sizes; radar bundle should not jump unexpectedly
```

## 2. Smoke test in the running app

Start the dev server (`npm start`, then open http://localhost:9000). If you cannot drive a browser from this session, give the user this checklist and ask them to run it — do not skip it silently.

Base checks (always):
- Map renders with the base layer; no errors in the DevTools console.
- Timeline fills all 13 cells and the play button animates through them; pause/step (arrow keys) works.
- Pan and zoom during playback — frames must not flicker to blank (sticky frames) and playback must resume after the gesture.

If the change touched panes, layers, playback, or interpolation:
- Switch to 2-pane and 4-pane split: every pane shows the same view, pans/zooms in lockstep, and animates in sync. New panes must NOT appear blank (a blank radar in a fresh pane = the `_userOpacity` clone bug class).
- Toggle a layer on/off in a non-primary pane via its pane pill; pane 0's playlist must not change.
- Toggle interpolation modes (off / crossfade / flow) in the ⋯ menu; opacity slider must not jump to 0.

If the change touched probe/crosshair/tools:
- Long-press the map → pistemittaus pin shows a dBZ value and chart; move the timeline cursor — value follows the frame.
- Crosshair mode shows a center readout that updates during playback.

If the change touched CSS or anything `position: fixed`:
- Check narrow-viewport layout (DevTools mobile emulation, iPhone size, with safe-area insets on) — toolbar, timeline, and pane pills must stay visible and tappable in 1-, 2-, and 4-pane layouts.

## 3. Edge-case trace (visual/coordinate changes)

Walk the code by hand at frame index 0, the last frame index, and with non-default WMS params (different STYLES / ELEVATION / narrow layer). This codebase's most common bug class is an off-by-one at the window edges.

## 4. Before pushing

- Confirm you are on a topic branch (`git branch --show-current` ≠ master).
- Commit, push the branch, open a PR — the PR gets an automatic preview deploy on `dev-tutka-meteo-fi`; verify the preview URL once CI finishes.
