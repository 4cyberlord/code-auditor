# Ray-Ban Meta → iOS Capture Pipeline Research

**Research snapshot:** August 29, 2026  
**Purpose:** Technical reference for building a third-party iOS app that connects to supported Meta AI glasses, receives camera imagery, queues multiple captures, and automatically processes them.

> This document separates **confirmed current SDK capabilities** from **proposed / requested capabilities** discussed by developers. Re-check Meta's current documentation before production work because the Device Access Toolkit (DAT) is evolving.

---

## 1. Target experience

The desired product behavior is:

```text
Ray-Ban Meta glasses
        │
        │ capture imagery
        ▼
Third-party iOS application
        │
        ├── receive image data
        ├── identify each capture
        ├── queue 10+ captures
        ├── process asynchronously
        ├── OCR / vision / AI
        ├── upload to an API
        └── save or route results
```

The important architectural goal is to make **capture independent from processing**. A new image should be accepted into the queue without waiting for the previous image's AI/OCR work to finish.

---

## 2. Executive conclusion

### Confirmed and practical

Meta's iOS Device Access Toolkit currently supports:

- Connecting a third-party iOS application to supported Meta glasses.
- Creating a `DeviceSession`.
- Adding the camera capability.
- Starting a live camera stream.
- Receiving individual video frames.
- Triggering a still capture through the SDK with `capturePhoto(format:)`.
- Receiving the resulting image bytes through `photoDataPublisher`.
- Processing, saving, uploading, or otherwise using those bytes in the developer's application.

Therefore, an application-controlled pipeline such as this is viable:

```text
Glasses → DAT DeviceSession → Camera/Stream → capturePhoto()
       → photoDataPublisher → Capture Queue → Processing
```

### Important limitation

Do **not** assume the public SDK currently provides a general API equivalent to:

```text
getEveryNativePhotoStoredOnTheGlasses()
```

or that pressing the glasses' ordinary physical camera button automatically delivers the original native full-resolution capture into an arbitrary third-party application.

Meta's developer community has specifically requested native/full-resolution capture and physical-button integration. Those requests are evidence that these should not be treated as established general DAT functionality.

For a first version, build around **DAT-controlled camera capture / streaming** and maintain a queue in the iOS application.

---

## 3. Current iOS SDK prerequisites

Meta's current iOS getting-started material lists:

- Xcode 15.0 or later.
- iOS 16.0 or later deployment target.
- Meta AI companion application installed on the test iPhone.
- Supported Ray-Ban Meta glasses or Meta Ray-Ban Display glasses.
- Developer Mode enabled in the Meta AI application.
- Meta Wearables DAT SDK added through Swift Package Manager.
- `MWDATCore` and `MWDATCamera` added to the application target.
- Required application configuration such as the Meta callback URL scheme / Info.plist settings.

Development can also use Meta's mock-device tooling where appropriate.

---

## 4. SDK camera architecture

A typical DAT camera lifecycle is:

```text
Select device
    ↓
Create DeviceSession
    ↓
Start DeviceSession
    ↓
Wait for .started
    ↓
Add Camera with StreamConfiguration
    ↓
Start stream
    ↓
Receive frames / capture photos
    ↓
Stop camera
    ↓
Stop DeviceSession
```

Meta's current camera documentation exposes stream resolutions including:

| Setting | Stream size |
|---|---:|
| `.high` | 720 × 1280 |
| `.medium` | 504 × 896 |
| `.low` | 360 × 640 |

Documented frame-rate choices include 2, 7, 15, 24, and 30 FPS.

Bluetooth bandwidth affects stream quality. Lower stream settings can sometimes be useful when the application cares more about reliable still capture or analysis than a high-frame-rate preview.

---

## 5. Receiving a photo directly in the app

The key SDK pattern is conceptually:

```swift
let photoToken = stream.photoDataPublisher.listen { photoData in
    let imageData = photoData.data

    // Give this capture a unique ID.
    // Store it temporarily.
    // Add it to the processing queue.
    // Upload / OCR / run vision AI as desired.
}

stream.capturePhoto(format: .jpeg)
```

This is the major advantage of DAT for the project: an SDK-triggered image can arrive as data in the application rather than requiring the app to wait for an Apple Photos import first.

---

## 6. Handling 10+ photographs

The application should never implement:

```text
capture #1
↓
wait for AI to finish
↓
capture #2
```

Instead:

```text
CAPTURE LAYER                   PROCESSING LAYER

capture #1 ─────┐
capture #2 ─────┤
capture #3 ─────┤
...             ├──→ IncomingCaptureQueue ─→ workers
capture #10 ────┘
```

Example queue:

```text
Incoming Captures

#001  received     → processing
#002  received     → processing
#003  received     → queued
#004  received     → queued
#005  received     → queued
...
#010  received     → queued
```

Each capture should have metadata similar to:

```json
{
  "captureId": "cap_00042",
  "createdAt": "2026-08-29T18:32:14-04:00",
  "source": "meta-dat",
  "status": "queued",
  "attempts": 0
}
```

Recommended state machine:

```text
requested
   ↓
receiving
   ↓
received
   ↓
queued
   ↓
processing
   ├──→ completed
   └──→ failed → retry
```

This design allows capture #10 to arrive while #1–#9 are still being analyzed.

---

## 7. Keep the session warm

For repeated captures, avoid rebuilding the entire connection for every image.

A desirable application state is:

```text
Glasses       CONNECTED
DeviceSession STARTED
Camera        READY
Stream        ACTIVE
Queue         READY
```

Then a capture becomes approximately:

```text
capture request
      ↓
capturePhoto()
      ↓
photoDataPublisher
      ↓
enqueue
      ↓
ready for another capture
```

This is preferable to repeatedly selecting the device, creating sessions, starting them, subscribing to publishers, capturing, and tearing everything down.

A Meta GitHub issue documents that a one-shot photo currently requires substantial session lifecycle orchestration and requests a higher-level helper API.

---

## 8. Native camera-button / stored-photo limitation

There are two workflows that must not be confused.

### A. DAT-controlled workflow

```text
Third-party app
      ↓
DAT camera session
      ↓
capturePhoto()
      ↓
photoDataPublisher
      ↓
third-party app
```

This gives the developer immediate programmatic control.

### B. Normal glasses photography workflow

```text
physical/normal glasses capture
      ↓
Meta's native capture pipeline
      ↓
media stored/imported through Meta workflow
      ↓
phone Photos library
```

Ray-Ban's current FAQ says captured media must be imported from the glasses before sharing; import transfers media to the phone's photo app through the Meta AI mobile app, and auto-import is enabled by default on supported iOS phones.

However, developer discussions requesting an API for native full-resolution capture and physical camera-button triggers show that **arbitrary retrieval of native stored captures should not be assumed to be available through DAT today**.

---

## 9. Resolution caveat

The glasses' native camera can produce substantially higher-quality imagery than the DAT streaming path.

Meta developer discussions in 2026 report DAT `capturePhoto()` output below the native sensor's full 12 MP capability. Reports vary by SDK version (for example, 720×1280 stream-derived behavior and reports of 1080×1440 still output), so the exact output should be benchmarked against the SDK version used in the project.

The critical conclusion is:

**Do not design around guaranteed native 12 MP DAT capture until Meta officially exposes and documents it.**

This matters particularly for:

- small printed text;
- documents;
- distant screens;
- OCR;
- fine diagrams;
- product labels;
- detailed computer-vision tasks.

A developer proposal asks Meta for an asynchronous native capture API that could trigger a full-resolution capture and transfer it to the companion app separately from the real-time Bluetooth stream.

---

## 10. Photos-library fallback

If normal Meta captures are auto-imported into the iPhone Photos library, a separate fallback architecture is possible:

```text
Glasses
   ↓
Meta AI import
   ↓
Apple Photos
   ↓
PhotoKit
   ↓
third-party application
```

Apple's `PHPhotoLibraryChangeObserver` can notify a registered application about changes to the photo library, including changes caused by another application.

This can be useful as a fallback for native Meta captures.

However, this is **not equivalent to a guaranteed always-running filesystem watcher**. iOS controls background execution and app suspension. Therefore, PhotoKit should not be treated as a promise that a terminated/suspended application will always awaken instantly for every Meta import.

For the lowest controllable latency, prefer a live DAT session when the user is actively using the capture feature.

---

## 11. Recommended application architecture

```text
┌───────────────────────────────┐
│      RAY-BAN META GLASSES     │
└──────────────┬────────────────┘
               │
               │ Meta DAT
               ▼
┌───────────────────────────────┐
│        Device Manager         │
│ connection / session states   │
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│        Camera Manager         │
│ stream / capturePhoto()       │
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│      Capture Coordinator      │
│ ID / timestamp / validation   │
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│      Persistent Queue         │
│ pending / running / failed    │
└──────────────┬────────────────┘
               │
       ┌───────┼────────┐
       ▼       ▼        ▼
      OCR    Vision    Upload
       │       │        │
       └───────┼────────┘
               ▼
┌───────────────────────────────┐
│        Result Store/UI        │
└───────────────────────────────┘
```

Suggested Swift components:

```text
WearableConnectionManager
MetaCameraManager
CaptureCoordinator
CaptureRepository
ProcessingQueue
VisionProcessor
UploadClient
ResultRepository
```

---

## 12. Reliability requirements

For a serious implementation, add:

- Unique capture IDs.
- Persistent local queue (not memory-only).
- Atomic writes for received image data.
- Duplicate detection.
- Timeout handling.
- Automatic retry with limits.
- Connection-state monitoring.
- Stream-state monitoring.
- Automatic recovery after a dropped stream where appropriate.
- Backpressure when the queue grows too large.
- Storage cleanup policy.
- Network reachability awareness.
- Per-capture error logs.
- Explicit user-visible camera/permission state.
- Privacy controls and deletion.
- Benchmark instrumentation.

Useful measurements:

```text
T0 = capture requested
T1 = photoDataPublisher received
T2 = image persisted
T3 = processing started
T4 = upload complete
T5 = AI response complete
```

Then record:

```text
capture latency      = T1 - T0
local ingest latency = T2 - T1
queue delay          = T3 - T2
AI/network latency   = T5 - T3
total latency        = T5 - T0
```

---

## 13. Recommended prototype plan

### Phase 1 — Connection

- Create minimal Swift iOS app.
- Install `MWDATCore` + `MWDATCamera`.
- Configure Meta callback settings.
- Enable Developer Mode.
- Register/connect glasses.
- Show live connection state.

### Phase 2 — Camera

- Create `DeviceSession`.
- Add camera.
- Start stream.
- Render a low/medium-resolution preview.
- Confirm stable reconnect behavior.

### Phase 3 — Still capture

- Subscribe to `photoDataPublisher`.
- Trigger `capturePhoto(.jpeg)`.
- Persist every received image with a UUID.
- Record latency.

### Phase 4 — Burst/queue test

Test:

```text
1 image
5 images
10 images
20 images
```

Measure missing captures, duplicates, connection drops, queue growth, thermal behavior, memory, and battery.

### Phase 5 — Processing

- Decouple capture and AI workers.
- Add OCR/vision.
- Limit concurrent network requests.
- Retry failed tasks.
- Preserve capture ordering when the product requires it.

### Phase 6 — Native-photo fallback

- Test Meta auto-import.
- Request appropriate Photos access.
- Implement PhotoKit change observation.
- Compare native-image quality and latency against DAT captures.

### Phase 7 — Production/distribution research

- Re-check Meta's current publishing/release-channel policy.
- Re-check Apple ExternalAccessory/MFi requirements.
- Confirm whether open App Store distribution has become available.

---

## 14. Distribution warning

As of the research snapshot, developers have reported Apple App Store review problems involving Meta's ExternalAccessory protocol and MFi Product Plan authorization.

A Meta GitHub discussion states that open publishing was not available at that point, while developers could build/test on-device and use supported testing/release channels.

This is a **distribution concern**, not proof that personal development/testing is impossible.

Before public release, verify the latest rules directly with Meta and Apple because this area is changing.

---

# Primary resources

## Meta official / first-party

### Meta Wearables Developer Center
https://developers.meta.com/wearables/

Use this as the primary entry point for current DAT platform information.

### Official Meta iOS DAT repository
https://github.com/facebook/meta-wearables-dat-ios

Source repository, samples, issues, discussions, SDK release information, and developer guidance.

### Meta iOS DAT — Getting Started
https://github.com/facebook/meta-wearables-dat-ios/blob/main/plugins/mwdat-ios/skills/getting-started/SKILL.md

Covers prerequisites, Swift Package Manager integration, Meta AI companion app, Developer Mode, and application configuration.

### Meta iOS DAT — camera/session guidance
https://github.com/facebook/meta-wearables-dat-ios/blob/main/.github/copilot-instructions.md

Contains camera streaming, `DeviceSession`, `StreamConfiguration`, `videoFramePublisher`, `photoDataPublisher`, and `capturePhoto(format:)` examples.

### Meta iOS DAT — AGENTS.md
https://github.com/facebook/meta-wearables-dat-ios/blob/main/AGENTS.md

Additional repository guidance on camera streaming, photo capture, bandwidth, and session management.

### Ray-Ban Meta FAQ — importing media
https://www.ray-ban.com/usa/c/frequently-asked-questions-meta-ray-ban-display

Documents Meta AI media import, phone Photos integration, Bluetooth pairing requirements, and auto-import behavior.

---

# Important developer discussions / issues

These are useful evidence about current limitations, but they are **community/developer discussions rather than promises of future Meta functionality**.

### Native full-resolution capture proposal — Discussion #119
https://github.com/facebook/meta-wearables-dat-ios/discussions/119

Explains the desire for an API that triggers native full-resolution camera capture and asynchronously transfers the image to the app. Also discusses the distinction between stream-derived DAT capture and the glasses' native sensor pipeline.

### `capturePhoto()` resolution discussion — Discussion #127
https://github.com/facebook/meta-wearables-dat-ios/discussions/127

Developer reports and discussion concerning `capturePhoto()` resolution versus the glasses' 12 MP sensor.

### 60 FPS / 12 MP request — Discussion #134
https://github.com/facebook/meta-wearables-dat-ios/discussions/134

Relevant especially for document OCR and fine-detail vision use cases.

### One-shot capture complexity — Issue #158
https://github.com/facebook/meta-wearables-dat-ios/issues/158

Documents the multi-step lifecycle currently required for a one-shot SDK photo and proposes a higher-level helper.

### App Store / MFi authorization — Issue #149
https://github.com/facebook/meta-wearables-dat-ios/issues/149

Developer report about Apple App Store MFi Product Plan authorization for applications using Meta's ExternalAccessory protocol.

### App Store publishing discussion — Discussion #138
https://github.com/facebook/meta-wearables-dat-ios/discussions/138

Contains a Meta-community response indicating open publishing was not available at that time and describing testing/release-channel options.

### DAT discussions index
https://github.com/facebook/meta-wearables-dat-ios/discussions

Useful for tracking new releases, limitations, camera behavior, developer questions, and workarounds.

### DAT issues index
https://github.com/facebook/meta-wearables-dat-ios/issues

Useful for monitoring current bugs, SDK regressions, connection issues, camera-stream problems, and resolved limitations.

---

# Apple resources

### `PHPhotoLibraryChangeObserver`
https://developer.apple.com/documentation/photos/phphotolibrarychangeobserver

Apple API for receiving notifications about photo-library changes, including changes originating from another application.

### Apple background execution documentation
https://developer.apple.com/documentation/xcode/configuring-background-execution-modes

Use when evaluating what an iOS application may legitimately continue doing while backgrounded or suspended.

---

# Final engineering recommendation

For the first working prototype, prioritize:

```text
Ray-Ban Meta
     ↓
DAT DeviceSession kept warm
     ↓
Camera stream
     ↓
SDK-controlled capturePhoto()
     ↓
photoDataPublisher
     ↓
persistent capture queue
     ↓
parallel/asynchronous processing
```

Treat this as a secondary/fallback route:

```text
normal glasses capture
     ↓
Meta AI auto-import
     ↓
Apple Photos
     ↓
PhotoKit observer
     ↓
processing queue
```

Do **not** make the first version dependent on undocumented access to every native photo stored on the glasses.

## Questions to re-check before production

1. Has Meta added native full-resolution still capture to DAT?
2. Can a third-party DAT app receive an event for the physical camera button?
3. Can native captures be enumerated/retrieved directly from glasses storage?
4. What resolution does `capturePhoto()` return on the exact current SDK/firmware?
5. What is the current public App Store distribution/MFi process?
6. What happens to the DAT stream when a native photo is taken?
7. What capture rate is sustainable for 10–20 rapid images?
8. What behavior occurs when the iPhone app backgrounds or the screen locks?

---

**Bottom line:** The core third-party wearable-camera application is technically viable today through Meta DAT. The safest architecture is an app-maintained DAT session plus a durable multi-image queue. Native stored-photo access and full-sensor capture should be treated as evolving capabilities and verified against the newest SDK before depending on them.
