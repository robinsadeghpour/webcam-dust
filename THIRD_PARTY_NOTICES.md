# Third-party notices

The code in this repository is MIT licensed (see `LICENSE`). It ships with, or loads at run time, the following work by others.

## @mediapipe/tasks-vision

- What: the MediaPipe vision tasks runtime (JavaScript and WebAssembly). It is installed from npm; the build copies its `wasm` folder into the site.
- Source: https://www.npmjs.com/package/@mediapipe/tasks-vision and https://github.com/google-ai-edge/mediapipe
- Licence: Apache License, Version 2.0

## Selfie segmentation model

- File: `public/models/selfie_segmenter.tflite`
- Downloaded from: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
- Model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf
- Licence, as stated on the model card: "Licensed under Apache License, Version 2.0"

## Pose landmarker (lite) model

- File: `public/models/pose_landmarker_lite.task`
- Downloaded from: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task
- Model card (BlazePose GHUM 3D, which the MediaPipe documentation links for this bundle): https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf
- Licence, as stated on the model card: "Licensed under Apache License, Version 2.0"

Both model files are unmodified. The full text of the Apache License, Version 2.0 is at https://www.apache.org/licenses/LICENSE-2.0

## Build tools

Vite (MIT) and TypeScript (Apache License, Version 2.0) are used to build the site and are not part of what is shipped.
