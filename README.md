# Plaque Burden — Cath Lab Device Runs

A single-page, offline-first web app for the cath lab: capture **IVUS / OCT device runs**, record lumen and EEM measurements frame by frame, and read out **plaque burden**, **stent expansion**, and **plaque prolapse** instantly — with a schematic cross-section diagram and a print-ready PDF export.

**Live:** https://plaque-burden.vercel.app

No accounts, no backend, no data leaves the device. Everything is stored locally in the browser (IndexedDB).

---

## What it does

### Measurements per frame (or per segment)
- **Lumen area** (mm²) and **EEM area** (mm²) entered with a drag/number wheel or typed directly.
- A **reference value** you choose yourself — proximal/distal reference, mean reference, or a custom number — and the app computes burden against it.
- Optional **stent** measurement (area + the reference type it is compared to) to compute **stent expansion**.
- Optional **plaque prolapse** classification, including tissue burden relative to the lumen.

### Derived results
| Metric | Formula |
| --- | --- |
| Plaque burden | `(EEM area − lumen area) / EEM area × 100%` |
| Stent expansion | `(stent area / reference area) × 100%` |
| Tissue / prolapse burden | computed against the selected lumen definition |
| Outside-stent plaque burden | plaque area outside the stent, when a stent is entered |
| Total plaque burden | overall burden irrespective of stent |

- **Equivalent-circle diameter** conversions are linked bidirectionally — type a diameter, get an area, and vice versa.
- **Bidirectional burden lock**: lock any one of the three values (EEM, lumen, or target burden) and the app solves for the remaining one, so you can ask "what lumen do I need for a 70% burden?" without doing the algebra.
- **Target planner**: set a desired post-PCI plaque burden or stent expansion target (slider + presets) and read the required area, diameter, and predicted residual burden.
- Live **SVG schematic** of the vessel cross-section: EEM contour, plaque, lumen, measured stent (white dashed), desired stent (green outline), and references.

### Study workflow
- **Device runs** group **segments** (frames). Each run carries vessel, phase, and modality annotations.
- **Records** screen: search, open, or delete saved studies, with per-study summaries (run/segment/photo counts, vessels, devices).
- **Photos** can be attached to a frame (with a viewer offering zoom/pan) and are embedded in the exported PDF.
- **PDF export**: export all segments, or select specific ones and export only those. The report is laid out for A4 with diagrams, metrics, patient data, and frame findings.

### Data safety (the part that matters clinically)
- Writes go to **IndexedDB with `durability: 'strict'`**, versioned by a monotonically increasing **revision** and an **edit token**.
- **Optimistic concurrency**: a save whose expected revision does not match is rejected with `conflict` instead of silently overwriting — safe with multiple tabs open.
- Deleted-in-another-tab studies are refused (`deleted`), and intentional deletions are never resurrected.
- Unfinished edits are **journaled to `sessionStorage`** on every change and recovered on next load; a conflicted journal is preserved as a *separate recovered record* rather than overwriting another tab's work.
- Photos orphaned by deletion are garbage-collected inside the same transaction.
- Storage quota failures surface a clear message telling you to export a PDF before retrying.
- `beforeunload` and `visibilitychange` flush pending saves.

---

## Tech

Deliberately dependency-free — no build step, no framework, no bundler.

- **`index.html`** — markup and static UI shell.
- **`app.js`** — the whole application (~640 lines): state, measurement model, wheel inputs, schematic rendering (SVG), PDF writer.
- **`study-store.js`** — IndexedDB persistence layer (`window.StudyStore`): open/upgrade, transactional save with revision checks, photo store, index, delete.
- **`styles.css`** — design system and responsive layout.
- Fonts: Manrope via Google Fonts (falls back to system UI).
- The **PDF exporter is hand-rolled** — it writes PDF objects, xref tables, and embedded JPEG XObjects directly, so no PDF library ships to the browser.

Static files only. `.vercel` is ignored via `.vercelignore`.

## Run locally

There is no toolchain to install. Serve the folder over HTTP:

```bash
cd plaque-burden
python3 -m http.server 5173
# open http://localhost:5173
```

Opening `index.html` via `file://` will not work — IndexedDB requires an HTTP origin.

## Deploy

The project is linked to Vercel (`plaque-burden`) as a static deployment:

```bash
vercel --prod
```

## Usage notes

- Enter **EEM** and **lumen** areas for the frame, then pick the reference used for burden.
- Use the **lock** control to solve for whichever value you did not measure.
- Set a **target** to see the balloon/stent size the plan implies.
- Add photos and notes per frame — both appear in the exported report.
- **Export selected** from the menu to build a report for only the frames you flagged.

## Disclaimer

A calculation aid for catheter-lab measurements, not a medical device. Every value derives from measurements you enter — verify against your imaging system before clinical use.

## License

Private project. All rights reserved.
