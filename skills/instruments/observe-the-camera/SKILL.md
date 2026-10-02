---
name: observe-the-camera
description: Acquire and retain a USB camera frame through an agent-owned sensor server. Use it for bench images, build checks, or reading the FM radio display.
---

1. Follow `scan-the-bench` before opening a camera. Select its V4L2 capture
   node and a supported resolution; never assume `/dev/video0` is the camera.
2. Fork `usb-camera` with `fork` and clone into your home. Follow the clone's
   README for offline validation, saving the branch, and foreground launch.
   One process owns a camera. Keep acquisition data outside the checkout.
3. Wait for READY with `status`, then `connect` with your process handle and
   its printed remote port. Only the workstation backend has endpoints.
4. `observe` the qualified sensor, such as `bench/camera`. Cite its retained
   manifest snapshot ref. Another specialist can observe through the same
   connection; do not share your private home or a temporary server URL.
5. Read the frame before describing the bench or the display. Report unclear
   when markings or digits cannot be read. For FM radio path A, the camera
   must show every display digit; no automatic digit reader is provided.
6. Synthetic demo observations are labelled as such. They prove the workflow,
   never a device reading. Capture errors require checking the device and
   repeating an explicit observation; never substitute a previous image.
7. Cancel before editing or rolling back the running version. Validate,
   commit, push, and start and connect a replacement. Disconnect alone does
   not stop the server. After a host restart, inspect processes and reconnect
   explicitly. Retained refs remain usable after process shutdown.
