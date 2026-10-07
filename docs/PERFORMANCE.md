# Autostereogram performance audit

Measured 2026-10-07T14:00:44.598Z. Source SHA-256: `17d2269310e743292dd584299b50478679b107c69bff9aaefae194936b72c4f5`.

Source files were unchanged throughout this run.

| Measurement (median) | Original | Upgraded | Change |
| --- | ---: | ---: | ---: |
| Committed slider → full-resolution preview | 94.7 ms | 57.6 ms | -39.2% |
| Drag → first preview | 105.6 ms | 36.1 ms | -65.8% |
| Drag release → final preview | 101.1 ms | 72.7 ms | -28.1% |
| Brush → first preview | 96.1 ms | 50.3 ms | -47.7% |
| Brush release → final preview | 93.6 ms | 110.8 ms | +18.4% |
| 3,300 px PNG ready | 748.2 ms | 772.9 ms | +3.3% |

## Method and limits

Isolated Edge context at 1440×1100; no user draft; no CPU throttling. Same input values, normalized gesture paths, repetitions and in-page post-draw markers as v1 baseline. Slider events dispatch input then change synchronously, thus measuring committed 1100px previews. Gestures may show adaptive 660px previews before final 1100px output. Input-to-draw excludes automation round-trip; gesture input duration includes mouse event dispatch. Export completion is the PNG download anchor click. Worker request/response intervals include scheduling, transfers and rendering; separate worker timing records come from inside the worker. postMessageMs measures synchronous main-thread serialization only. Other agents may be active.

Twenty slider changes, six object drags, six brush strokes and five PNG exports reproduce the original baseline sequence. Slider previews are 1,100 px in both versions. Gesture first previews may be 660 px in the upgraded version; final previews are 1,100 px. Export timings include PNG encoding and download preparation. Small timing differences should be treated as noise on this unthrottled development machine.

## Main-thread and worker audit

Normal frame postMessage: 0.10 ms median / 0.50 ms p95. Eight painted layers containing 14,126,592 bytes of fields and masks: 8.60 ms median / 9.10 ms p95. Heavy-scene input-to-draw: 86.1 ms median.

0 long tasks (>50 ms) occurred within the measured slider, drag, brush and stress-slider intervals. 4 occurred across the full run, including setup, project opening and export. The raw JSON records all task timestamps and durations.

Worker timings are not directly comparable across versions: the upgraded worker also composes the depth scene and renders the relief, operations previously performed on the main thread. User-visible input and export timings are the appropriate comparison.

Static review confirmed that the UI sends asset pruning, asset registration and each frame in FIFO order to a synchronous worker. The active-asset budget prevents eviction of assets required by the next frame; URL/dimension deduplication avoids uploading identical imported images repeatedly. Clipboard/history operations use independent asset buffers where needed and structurally shared immutable history buffers. A dedicated memory regression verifies the 64 MiB history cap.

Browser errors: 0. Worker errors: 0.
