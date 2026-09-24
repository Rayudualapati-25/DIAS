# Iteration 019 — Place latency graphs below Section 5.3

## Change

- Anchored `interactive_latency_three_panel.pdf` at the start of Section 5.3 in `output/overleaf/SEBA_XAI_Overleaf_Package/main.tex`.
- Enabled bottom placement for the two-column figure with `stfloats` and `figure* [!b]`.
- Added a controlled page boundary after Section 5.3 so Section 6 begins only after both full-width Results figures.
- Kept the graph data, caption, labels, and all reported measurements unchanged.

## Verification evidence

- `tectonic main.tex --outdir verify-build-clearpage --keep-logs --keep-intermediates` completed successfully.
- `pdfinfo verify-build-clearpage/main.pdf` reports exactly 6 pages.
- Rendered page 5 shows all three latency panels below the Section 5.3 discussion; page 6 retains the limitations, explainable-AI future work, ethics, and references.
- The verified build is in `output/overleaf/SEBA_XAI_Overleaf_Package/verify-build-clearpage/main.pdf`.

## Self-improvement loop

- **Worked:** Declaring the double-column float at the Section 5.3 boundary allowed LaTeX to reserve the bottom of page 5 for the graphs; the page boundary keeps Section 6 in document order on page 6.
- **Failed/weak:** A first attempt declared the bottom float after the subsection prose; LaTeX deferred it until the bottom of page 6, after the references.
- **Next refinement:** If the paper text changes, rerender pages 5–6 and confirm both graph readability and the six-page limit before packaging.
