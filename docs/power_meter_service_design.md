# Power Meter Service Design (WattsUp Pro)

## Overview

This document defines the architecture and behavior of the Power Meter
Service used within the orchestrator. It describes how the system
discovers, connects to, and streams data from a WattsUp Pro serial power
meter device, and how multiple recorders can operate simultaneously
(benchmark-, UI-, or feature-driven).

The design is structured to be readable by both humans and AI systems to
enable future expansion.

------------------------------------------------------------------------

## 1. Device Discovery & Lifecycle

The orchestrator uses the existing `SerialDiscoveryService` to detect
compatible devices.

### Matcher Configuration

-   **kind:** `power.meter.wattsup`
-   **identifyRequired:** `false`
-   **baudRate:** `115200`
-   **keepOpenOnStatic:** `false`
-   Optional: VID/PID/pathRegex filters to narrow matching.

### Discovery Events

-   `device:identified` → PowerMeterService attaches.
-   `device:lost` → PowerMeterService tears down stream & notifies
    dependents.
-   `device:error` → Soft failure; logged and broadcast as needed.

The PowerMeterService does not rely on active token-based
identification.

------------------------------------------------------------------------

## 2. PowerMeterService

### Responsibilities

1.  Maintain serial connection to the WattsUp device.
2.  Initialize device with required protocol commands.
3.  Parse incoming `#d,...` frames into structured samples.
4.  Emit live sample events.
5.  Maintain a rolling buffer of recent samples.
6.  Manage multiple independent recording sessions.
7.  Handle disconnections, reconnections, and error propagation.

### Initialization Command Sequence

1.  `#V,3;` -- version/capability request.
2.  `#L,W,3,E,,1;` -- logging interval = 1 second.
3.  `#O,W,1,3;` -- full output formatting.

On shutdown, the service sends:\
`#L,W,0;` -- stop logging.

------------------------------------------------------------------------

## 3. Power Sample Format

``` ts
interface PowerSample {
  ts: string;     // ISO timestamp
  watts: number;
  volts: number;
  amps: number;

  whRaw?: number | null;
  wattsAltRaw?: number | null;
  powerFactorRaw?: number | null;

  rawLine?: string;
}
```

Parsed from WattsUp fields: - Watts = fields\[3\] / 10\
- Volts = fields\[4\] / 10\
- Amps = fields\[5\] / 1000

------------------------------------------------------------------------

## 4. Recording Model

The system supports **multiple simultaneous recorders**, each consuming
the shared live stream.

### Recorder Interface

Each recorder tracks: - start/stop timestamps - samples collected -
rolling averages/min/max - optional domain-specific metadata

This allows: - Benchmark recordings - UI-triggered recordings - Future
derived-recordings (e.g., 5-second window averages)

Recorders are stored in an extensible map:

``` ts
Map<string, RecorderInstance>
```

### Recording Summary

``` ts
interface PowerRecordingSummary {
  recorderId: string;
  startedAt: string;
  endedAt: string;
  sampleCount: number;

  avgWatts: number | null;
  minWatts: number | null;
  maxWatts: number | null;

  avgVolts: number | null;
  minVolts: number | null;
  maxVolts: number | null;

  avgAmps: number | null;
  minAmps: number | null;
  maxAmps: number | null;

  wattSeconds?: number | null;
  wattHoursApprox?: number | null;

  missingIntervals?: number;
}
```

------------------------------------------------------------------------

## 5. WebSocket Integration

### Outgoing messages

-   `powerMeter:status`
-   `powerMeter:sample`
-   `powerMeter:recordingUpdate`

### Incoming messages

-   `powerMeter:startRecording`
-   `powerMeter:stopRecording`

UI recorder sessions are isolated from benchmark sessions.

------------------------------------------------------------------------

## 6. Error Handling & Reconnection

### While recording for a benchmark:

-   Device loss → **fatal for current run**
-   Device misbehavior / missing samples → invalidates run
-   Orchestrator decides whether to retry or halt pipeline

### While idle (no recordings):

-   Device loss → **warning**
-   Reconnection automatically resumes streaming

### Hard failures:

If the device cannot reconnect over a configurable window: - System
escalates to a **pipeline-fatal** condition

------------------------------------------------------------------------

## 7. Sampling Frequency

Current design uses **1 Hz** sampling via: `#L,W,3,E,,1;`

Future possibility: - Make interval configurable - Re-issue logging
interval dynamically

The architecture does not depend on a fixed interval.

------------------------------------------------------------------------

## 8. Future Extensions

-   Multi-device support
-   Derived metric recorders (interval-based averages)
-   Streaming energy consumption graphs
-   Persistent logging to disk
-   Telemetry for missing-frame analysis
-   Hot-pluggable device selection from UI

------------------------------------------------------------------------

## 9. Summary

This design: - Integrates the WattsUp Pro device into the orchestrator -
Supports multiple parallel recording streams - Provides live and
historical power metrics - Handles device disruptions gracefully - Is
structured for future extensibility
