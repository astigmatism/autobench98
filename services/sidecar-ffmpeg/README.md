# FFmpeg Sidecar

**Role:** Process-level agent close to the OS and codecs.

-   Exposes simple control API: `/health`, `/ready`, `/start`, `/stop`, `/status`.
-   Responsible for spawning `ffmpeg`, parsing stderr for progress, and reporting status.
-   Leaves device/GPU access and host mounts to its container runtime.
