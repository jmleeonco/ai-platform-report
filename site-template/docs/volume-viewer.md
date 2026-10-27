# Sample visualization — the 3D slice overlay viewer (default)

**Live demo: [examples/volume-viewer.html](examples/volume-viewer.html)** (synthetic phantom).

When a report shows **cases / samples** (CT, MR, PET volumes with ground truth and/or
predictions), the default is the interactive viewer, not screenshots. Readers can then
scroll every slice, compare GT vs prediction, change the window, and rotate a 3D view —
instead of trusting the three slices the author happened to pick.

Use static PNGs only when the user asks for them, for 2D-only data, or for plots / curves /
diagrams (those are not samples).

## Make a volume

```bash
aireport viewer --image CT.nii.gz --label GT.nii.gz --pred PRED.nii.gz \
    --names "1:Liver,2:Spleen,3:Tumor" --case LTS-017 \
    -o <work dir>/assets/LTS-017.vol.json
```

then put the printed line where the case belongs in the page:

```html
<script type="application/json" class="vol-island" data-src="assets/LTS-017.vol.json"></script>
```

| Option | Default | Notes |
|---|---|---|
| `--image` | — | NIfTI (nibabel) or NRRD / MHA / DICOM dir (SimpleITK). Reoriented to RAS. |
| `--label PATH` | — | ground truth, drawn **filled**. Repeatable. |
| `--pred PATH` | — | prediction, drawn as **contour**. Repeatable. |
| `--overlay NAME=PATH[:fill\|contour]` | — | any other label map (e.g. a second model). |
| `--names` | `label N` | `"1:Liver,2:Tumor"`, a JSON `{"1": "Liver"}`, or a `1 Liver` per-line file. |
| `--case`, `--caption` | file name / none | shown in the viewer toolbar / under it. Anonymized IDs only. |
| `--margin MM` / `--no-crop` | crop to labels + 40 mm | cropping spends the voxel budget on the region that matters. |
| `--max-dim N` | 160 | largest axis after resampling. 160 → typically 0.3–3 MB per case. |
| `--modality`, `--range LO HI`, `--window C W` | auto; CT −1000..1000, W/L 40/400 | MR uses the 0.5–99.5 percentile range. |

Labels must be on the same voxel grid as the image (same shape); resample them first if
not. Label values must be ≤ 255. Same label value → same colour in every overlay.

`aireport phantom -o assets/demo.vol.json` writes a synthetic demo (no patient data).

## What readers get

- **Axial / Sagittal / Coronal** panes (radiological convention: patient right on screen
  left), linked crosshair. Wheel or ↑↓ scrolls slices; click-drag moves the crosshair;
  right-drag (or Alt-drag) = window/level; Ctrl-wheel zooms; Shift-drag pans.
- **3D pane**: the three current slices placed in space plus label surfaces (subsampled
  boundary voxels, shaded); drag rotates, wheel zooms; toggles for slices / hide air / surfaces.
- Toolbar: per-overlay on/off and fill ↔ contour, overlay opacity, window presets
  (CT: soft tissue, lung, bone, brain). Legend chips hide single labels. ⤢ maximises a pane.
- Hover read-out: voxel index, intensity (HU for CT), labels under the cursor.

## Several cases

One island per case. A good pattern is one heading per case with a line of commentary
(what to look at, which slice shows the failure), then the viewer. Viewers load lazily as
they scroll into view, so ten cases on a page are fine; keep the total page under ~50 MB.
For a quick visual gallery across many cases, a PNG grid *plus* viewers for the
interesting ones is fine.

## Privacy

Volumes contain voxel data only (no DICOM header), but they are still images of a patient:
only de-identified research data that is allowed on the internal network; `--case` must be
an anonymized ID.

## Inline volumes

Without `data-src`, the island's own text is the volume JSON (works when the HTML file is
opened from disk). Generate with `aireport viewer -o x.vol.json` and paste the file contents
into the island. Only do this for small volumes or when a single self-contained file is
required.
