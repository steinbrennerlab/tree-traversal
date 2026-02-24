# Prompts Log

| Date | Prompt Summary | Commands Run |
|------|---------------|--------------|
| 2026-02-24 | Design scalable tree browser with species highlighting, motif search, shared node highlighting | Explored input/ structure, installed fastapi+uvicorn via micromamba, created browser/app.py (FastAPI backend), browser/static/{index.html,app.js,style.css}, browser/run.sh. Tested all API endpoints successfully. |
| 2026-02-24 | Add circular and unrooted tree layout options | Refactored app.js: split renderTree into 3 layout modes (rectangular/circular/unrooted). Added layout radio buttons to index.html. Circular uses polar coords with arcs; unrooted uses Felsenstein equal-angle algorithm. JS syntax verified. |
| 2026-02-24 | Add name search and species exclusion to shared nodes | Added client-side name search (regex on tip names, blue highlighting). Added exclude species list to shared nodes section (collapsible). Backend updated: /api/nodes-by-species now accepts `exclude` param. Tested: exclusion correctly filters nodes. |
| 2026-02-24 | Add alignment export feature | Added /api/node-tips, /api/tip-names, /api/export endpoints to app.py. Export panel in sidebar (index.html). Shift+click on node opens export panel (app.js). Supports full alignment, column range, and reference-sequence-based position slicing. Downloads gapped FASTA. Added export panel CSS. Python and JS syntax verified. |
| 2026-02-24 | Five UI enhancements | 1) Tip label toggle checkbox. 2) Name search shows up to 10 matching names below results. 3) Bootstrap value toggle checkbox. 4) Export panel visible by default with "Shift-click a node to select" hint. 5) Export validates extra tip names client-side and shows "not found" error. All syntax verified. |
| 2026-02-24 | Tip labels on separate lines | Wrapped each Layout checkbox (branch lengths, tip labels, bootstraps) in `<div>` for separate lines. |
| 2026-02-24 | Always-visible tip dots with highlighting | Added drawTipDot() helper drawn at every tip in all 3 layouts. Dots colored by motif (red) > name (blue) > species > grey. Visible even when tip labels are hidden. |
| 2026-02-24 | Species color on tip dots when labels hidden | Updated drawTipDot to accept checkedSpecies, use getNodeColor as fallback so species coloring shows on dots even with labels off. |
| 2026-02-24 | Update prompts.md and create README.md | Updated prompts log and created browser/README.md documenting setup, usage, features, and API. |
