#include <ps2dev.h>
#include <EEPROM.h>
#include <string.h>
#include <stdlib.h>

#define ID "MS"
#define PS2_CLOCK_PIN 3
#define PS2_DATA_PIN 2
#define POWER_STATUS_PIN 5

// ----------------------------
// Firmware logging controls
// ----------------------------
#define FW_DEBUG 0
#define FW_LOG_PS2_COMMANDS 0
#define FW_LOG_SERIAL_COMMANDS 0
#define FW_LOG_POWER_CHANGES 1

#if FW_DEBUG
  #define DBG_PRINT(x) Serial.print(x)
  #define DBG_PRINTLN(x) Serial.println(x)
#else
  #define DBG_PRINT(x) do {} while (0)
  #define DBG_PRINTLN(x) do {} while (0)
#endif

PS2dev mouse(PS2_CLOCK_PIN, PS2_DATA_PIN);

bool isIdentified = false;
bool isInitialized = false;
bool isPCPoweredOn = false;
bool lastPowerStatus = false;

// PS/2 protocol state
bool isReporting = false;   // enabled via PS/2 command (0xF4)
bool isRemoteMode = false;  // set via 0xF0, cleared via 0xEA

// buttons[0]=left, buttons[1]=right, buttons[2]=middle
char buttons[3] = {0, 0, 0};

// Absolute cursor tracking from serial MOVE x,y protocol
int last_x = 0;
int last_y = 0;

// Accumulated motion to inject (in *firmware internal* coords: +Y = down)
long acc_dx = 0;
long acc_dy = 0;

// Host-configured sample rate (0xF3)
uint16_t sampleRateHz = 100;           // common default
uint16_t sampleIntervalMs = 10;        // 1000/100
unsigned long lastSampleSentMs = 0;

// ----------------------------
// PS/2 TX frame queue (prevents partial packet corruption)
//
// NOTE (IMPORTANT):
// The Arduino build system auto-generates function prototypes. If a prototype
// uses a user-defined type declared later in the .ino, compilation can fail.
// To keep this sketch "prototype-safe" across Arduino IDE / arduino-cli,
// this TX queue uses ONLY built-in types (no structs in function signatures).
// ----------------------------

static const uint8_t TX_HI_CAP = 16;
static const uint8_t TX_LO_CAP = 16;

// High-priority queue storage (len + 3 bytes per frame)
static uint8_t txHiLen[TX_HI_CAP];
static uint8_t txHiB0[TX_HI_CAP];
static uint8_t txHiB1[TX_HI_CAP];
static uint8_t txHiB2[TX_HI_CAP];
static uint8_t txHiHead = 0, txHiTail = 0;

// Low-priority queue storage
static uint8_t txLoLen[TX_LO_CAP];
static uint8_t txLoB0[TX_LO_CAP];
static uint8_t txLoB1[TX_LO_CAP];
static uint8_t txLoB2[TX_LO_CAP];
static uint8_t txLoHead = 0, txLoTail = 0;

// Current frame being transmitted (supports partial send if host inhibits)
static bool txActive = false;
static uint8_t txCurLen = 0;
static uint8_t txCur[3] = {0, 0, 0};
static uint8_t txCurIdx = 0;

static inline uint8_t nextIdx(uint8_t i, uint8_t cap) {
  return (uint8_t)((i + 1) % cap);
}

static void txReset() {
  txHiHead = txHiTail = 0;
  txLoHead = txLoTail = 0;
  txActive = false;
  txCurLen = 0;
  txCurIdx = 0;
  txCur[0] = txCur[1] = txCur[2] = 0;
}

static bool txHiPush(uint8_t len, uint8_t b0, uint8_t b1, uint8_t b2) {
  uint8_t nt = nextIdx(txHiTail, TX_HI_CAP);
  if (nt == txHiHead) return false; // full
  txHiLen[txHiTail] = len;
  txHiB0[txHiTail] = b0;
  txHiB1[txHiTail] = b1;
  txHiB2[txHiTail] = b2;
  txHiTail = nt;
  return true;
}

static bool txLoPush(uint8_t len, uint8_t b0, uint8_t b1, uint8_t b2) {
  uint8_t nt = nextIdx(txLoTail, TX_LO_CAP);
  if (nt == txLoHead) return false; // full
  txLoLen[txLoTail] = len;
  txLoB0[txLoTail] = b0;
  txLoB1[txLoTail] = b1;
  txLoB2[txLoTail] = b2;
  txLoTail = nt;
  return true;
}

static bool txHiPop(uint8_t &len, uint8_t &b0, uint8_t &b1, uint8_t &b2) {
  if (txHiHead == txHiTail) return false;
  len = txHiLen[txHiHead];
  b0 = txHiB0[txHiHead];
  b1 = txHiB1[txHiHead];
  b2 = txHiB2[txHiHead];
  txHiHead = nextIdx(txHiHead, TX_HI_CAP);
  return true;
}

static bool txLoPop(uint8_t &len, uint8_t &b0, uint8_t &b1, uint8_t &b2) {
  if (txLoHead == txLoTail) return false;
  len = txLoLen[txLoHead];
  b0 = txLoB0[txLoHead];
  b1 = txLoB1[txLoHead];
  b2 = txLoB2[txLoHead];
  txLoHead = nextIdx(txLoHead, TX_LO_CAP);
  return true;
}

static bool txEnqueueHi1(uint8_t b0) {
  return txHiPush(1, b0, 0, 0);
}
static bool txEnqueueHi2(uint8_t b0, uint8_t b1) {
  return txHiPush(2, b0, b1, 0);
}
static bool txEnqueueHi3(uint8_t b0, uint8_t b1, uint8_t b2) {
  return txHiPush(3, b0, b1, b2);
}
static bool txEnqueueLo3(uint8_t b0, uint8_t b1, uint8_t b2) {
  return txLoPush(3, b0, b1, b2);
}

static bool txLoadNextFrame() {
  uint8_t len, b0, b1, b2;
  if (txHiPop(len, b0, b1, b2) || txLoPop(len, b0, b1, b2)) {
    txCurLen = len;
    txCur[0] = b0;
    txCur[1] = b1;
    txCur[2] = b2;
    txCurIdx = 0;
    txActive = true;
    return true;
  }
  return false;
}

// Service TX queue (call often)
static void txService() {
  if (!txActive) {
    if (!txLoadNextFrame()) return;
  }

  // Attempt to send as much as possible. If a write fails, stop and retry later.
  while (txActive) {
    int rc = mouse.write(txCur[txCurIdx]);
    if (rc == 0) {
      txCurIdx++;
      if (txCurIdx >= txCurLen) {
        txActive = false;
        txCurIdx = 0;

        // Immediately load and continue if another frame is queued.
        if (txLoadNextFrame()) {
          continue;
        }
        return;
      }
      continue;
    }

    // Can't write right now (host inhibited / bus busy). Retry next loop.
    return;
  }
}

// ----------------------------
// PS/2 data packet builder
// ----------------------------

// PS/2 expects: +Y = up, -Y = down.
// Our internal acc_dy is +down, so we invert at the packet boundary.
static void buildDataPacket(int dx_internal, int dy_internal, uint8_t out[3]) {
  // clamp to spec range [-255, +255]
  int x = dx_internal;
  int y = -dy_internal; // invert Y at PS/2 boundary

  if (x > 255) x = 255;
  if (x < -255) x = -255;

  if (y > 255) y = 255;
  if (y < -255) y = -255;

  uint8_t xSign = (x < 0) ? 1 : 0;
  uint8_t ySign = (y < 0) ? 1 : 0;

  uint8_t data0 =
      (1 << 3) |
      ((ySign & 1) << 5) |
      ((xSign & 1) << 4) |
      ((buttons[2] & 1) << 2) |
      ((buttons[1] & 1) << 1) |
      ((buttons[0] & 1) << 0);

  uint8_t data1 = (uint8_t)(x & 0xFF);
  uint8_t data2 = (uint8_t)(y & 0xFF);

  out[0] = data0;
  out[1] = data1;
  out[2] = data2;
}

static void enqueueDataPacketInternal(int dx_internal, int dy_internal, bool highPriority) {
  uint8_t p[3];
  buildDataPacket(dx_internal, dy_internal, p);

  // If queueing fails, we avoid sending partial data. Worst case: movement slows / drops.
  if (highPriority) {
    (void)txEnqueueHi3(p[0], p[1], p[2]);
  } else {
    (void)txEnqueueLo3(p[0], p[1], p[2]);
  }
}

// ----------------------------
// Helpers: sample rate handling
// ----------------------------
static void setSampleRate(uint8_t hz) {
  // Accept any sane 1..200, but clamp to avoid division issues.
  uint16_t v = hz;
  if (v < 1) v = 1;
  if (v > 200) v = 200;

  sampleRateHz = v;
  sampleIntervalMs = (uint16_t)(1000 / sampleRateHz);
  if (sampleIntervalMs < 1) sampleIntervalMs = 1;
}

// ----------------------------
// Serial command parsing (non-blocking, no String allocations)
// ----------------------------
static char cmdBuf[64];
static uint8_t cmdLen = 0;

static void trimInPlace(char *s) {
  if (!s) return;

  // Trim leading spaces/tabs by shifting the string left.
  char *p = s;
  while (*p == ' ' || *p == '\t') p++;
  if (p != s) {
    memmove(s, p, strlen(p) + 1);
  }

  // Trim trailing spaces/tabs.
  size_t n = strlen(s);
  while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t')) {
    s[n - 1] = '\0';
    n--;
  }
}

static bool startsWith(const char *s, const char *prefix) {
  while (*prefix) {
    if (*s++ != *prefix++) return false;
  }
  return true;
}

static void handleSerialCommand(char *raw) {
  // raw is NUL-terminated; strip CR and spaces
  trimInPlace(raw);
  if (raw[0] == '\0') return;

#if FW_LOG_SERIAL_COMMANDS
  Serial.print(F("serial cmd: "));
  Serial.println(raw);
#endif

  if (strcmp(raw, "identify") == 0) {
    isIdentified = false;
    Serial.println(ID);
    return;
  }

  if (!isIdentified && strcmp(raw, "identify_complete") == 0) {
    isIdentified = true;
    Serial.println(F("mouse identification complete"));
    return;
  }

  if (!isIdentified) return;

  // Commands only after identified
  if (startsWith(raw, "MOVE ")) {
    // Expected: "MOVE x,y" (absolute positions)
    const char *body = raw + 5;
    const char *comma = strchr(body, ',');
    if (!comma) return;

    int new_x = atoi(body);
    int new_y = atoi(comma + 1);

    int dx = new_x - last_x;
    int dy = new_y - last_y;

    // clamp huge inputs just in case
    if (dx > 255) dx = 255;
    if (dx < -255) dx = -255;
    if (dy > 255) dy = 255;
    if (dy < -255) dy = -255;

    last_x = new_x;
    last_y = new_y;

    // Accumulate in firmware internal coords (+Y = down)
    acc_dx += dx;
    acc_dy += dy;

    // Bound accumulator to avoid runaway backlog if host can't keep up
    const long CAP = 4096;
    if (acc_dx > CAP) acc_dx = CAP;
    if (acc_dx < -CAP) acc_dx = -CAP;
    if (acc_dy > CAP) acc_dy = CAP;
    if (acc_dy < -CAP) acc_dy = -CAP;

    return;
  }

  if (startsWith(raw, "CLICK ")) {
    int button = atoi(raw + 6);
    if (button >= 0 && button < 3) {
      buttons[button] = 1;

      // If reporting enabled and not remote, send immediate button packet (hi priority).
      if (isReporting && !isRemoteMode) {
        enqueueDataPacketInternal(0, 0, true);
      }

#if FW_LOG_SERIAL_COMMANDS
      Serial.print(F("mouse button "));
      Serial.print(button);
      Serial.println(F(" held"));
#endif
    }
    return;
  }

  if (startsWith(raw, "RELEASE ")) {
    int button = atoi(raw + 8);
    if (button >= 0 && button < 3) {
      buttons[button] = 0;

      if (isReporting && !isRemoteMode) {
        enqueueDataPacketInternal(0, 0, true);
      }

#if FW_LOG_SERIAL_COMMANDS
      Serial.print(F("mouse button "));
      Serial.print(button);
      Serial.println(F(" released"));
#endif
    }
    return;
  }

  // Unknown serial command => ignore (do not spam)
}

// Service serial input buffer
static void serviceSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\r') continue;

    if (c == '\n') {
      cmdBuf[cmdLen] = '\0';
      handleSerialCommand(cmdBuf);
      cmdLen = 0;
      continue;
    }

    if (cmdLen < (sizeof(cmdBuf) - 1)) {
      cmdBuf[cmdLen++] = c;
    } else {
      // overflow: drop line
      cmdLen = 0;
    }
  }
}

// ----------------------------
// PS/2 command handling
// ----------------------------

// Param handling to avoid arg bytes being treated as standalone commands
enum PendingParam { PENDING_NONE = 0, PENDING_SAMPLE_RATE, PENDING_RESOLUTION };
static PendingParam pendingParam = PENDING_NONE;
static unsigned long pendingSinceMs = 0;
static const unsigned long PENDING_EXPIRE_MS = 100;

static void clearPendingIfExpired() {
  if (pendingParam == PENDING_NONE) return;
  if (millis() - pendingSinceMs > PENDING_EXPIRE_MS) {
    pendingParam = PENDING_NONE;
  }
}

static void ack() {
  // Enqueue ACK (0xFA) as hi priority
  (void)txEnqueueHi1(0xFA);
}

static void send_status() {
  // Minimal status response (3 bytes). Keep simple; include button states in byte0 optionally.
  // For maximum compatibility we keep it 0x00s (some drivers ignore).
  (void)txEnqueueHi3(0x00, 0x00, 0x00);
}

static void handleReadDataRemoteMode() {
  // In remote mode, host asks for a single 3-byte data packet.
  // Use accumulated deltas (clamped), then clear accumulator (typical behavior).
  int dx = 0;
  int dy = 0;

  if (acc_dx != 0) {
    long v = acc_dx;
    if (v > 255) v = 255;
    if (v < -255) v = -255;
    dx = (int)v;
    acc_dx -= dx;
  }

  if (acc_dy != 0) {
    long v = acc_dy;
    if (v > 255) v = 255;
    if (v < -255) v = -255;
    dy = (int)v;
    acc_dy -= dy;
  }

  // Remote mode response must be hi priority
  enqueueDataPacketInternal(dx, dy, true);
}

static void mouse_command(unsigned char command) {
#if FW_LOG_PS2_COMMANDS
  Serial.print(F("ps2 cmd=0x"));
  if (command < 0x10) Serial.print('0');
  Serial.println(command, HEX);
#endif

  clearPendingIfExpired();

  // If awaiting a parameter byte, treat this byte as the parameter.
  if (pendingParam != PENDING_NONE) {
    ack(); // ACK the parameter byte

    if (pendingParam == PENDING_SAMPLE_RATE) {
      setSampleRate(command);
#if FW_LOG_PS2_COMMANDS
      Serial.print(F("mouse sample rate set to "));
      Serial.println((int)sampleRateHz);
#endif
    } else if (pendingParam == PENDING_RESOLUTION) {
      // Resolution not used by this firmware (we emulate only baseline PS/2).
#if FW_LOG_PS2_COMMANDS
      Serial.print(F("mouse resolution arg=0x"));
      if (command < 0x10) Serial.print('0');
      Serial.println(command, HEX);
#endif
    }

    pendingParam = PENDING_NONE;
    return;
  }

  switch (command) {
    case 0xFF: // Reset
      ack();
      // Reset defaults
      isReporting = false;
      isRemoteMode = false;
      buttons[0] = buttons[1] = buttons[2] = 0;
      acc_dx = acc_dy = 0;
      last_x = last_y = 0;
      setSampleRate(100);

      // After ACK, device sends 0xAA then ID 0x00.
      (void)txEnqueueHi2(0xAA, 0x00);
      isInitialized = true;

#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse reset"));
#endif
      break;

    case 0xFE: // Resend (host asks to resend last packet; we don't track last, so ACK and do nothing)
      ack();
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse resend requested"));
#endif
      break;

    case 0xF6: // Set defaults
      ack();
      isReporting = false;
      isRemoteMode = false;
      buttons[0] = buttons[1] = buttons[2] = 0;
      acc_dx = acc_dy = 0;
      last_x = last_y = 0;
      setSampleRate(100);
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse set defaults"));
#endif
      break;

    case 0xF5: // Disable data reporting
      isReporting = false;
      ack();
      // Clear movement to avoid a jump on re-enable
      acc_dx = acc_dy = 0;
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse reporting disabled"));
#endif
      break;

    case 0xF4: // Enable data reporting
      isReporting = true;
      ack();
      // Reset timing window so we don't burst immediately
      lastSampleSentMs = millis();
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse reporting enabled"));
#endif
      break;

    case 0xF3: // Set sample rate (expects 1 arg byte)
      ack();
      pendingParam = PENDING_SAMPLE_RATE;
      pendingSinceMs = millis();
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse set sample rate (await arg)"));
#endif
      break;

    case 0xF2: // Get device ID
      ack();
      // Standard PS/2 mouse ID = 0x00
      (void)txEnqueueHi1(0x00);
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse get device id"));
#endif
      break;

    case 0xF0: // Set remote mode
      ack();
      isRemoteMode = true;
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse remote mode"));
#endif
      break;

    case 0xEE: // Set wrap mode
      ack();
      break;

    case 0xEC: // Reset wrap mode
      ack();
      break;

    case 0xEB: // Read data (remote mode)
      ack();
      handleReadDataRemoteMode();
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse read data"));
#endif
      break;

    case 0xEA: // Set stream mode
      ack();
      isRemoteMode = false;
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse stream mode"));
#endif
      break;

    case 0xE9: // Status request
      ack();
      send_status();
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse status"));
#endif
      break;

    case 0xE8: // Set resolution (expects 1 arg byte)
      ack();
      pendingParam = PENDING_RESOLUTION;
      pendingSinceMs = millis();
#if FW_LOG_PS2_COMMANDS
      Serial.println(F("mouse set resolution (await arg)"));
#endif
      break;

    case 0xE7: // Set scaling 2:1
      ack();
      break;

    case 0xE6: // Set scaling 1:1
      ack();
      break;

    default:
      // Unknown: request resend (0xFE) (hi priority)
      (void)txEnqueueHi1(0xFE);
#if FW_LOG_PS2_COMMANDS
      Serial.print(F("mouse unknown cmd=0x"));
      if (command < 0x10) Serial.print('0');
      Serial.println(command, HEX);
#endif
      break;
  }
}

static void handlePS2Communication() {
  // Drain a small burst so cmd+arg sequences are handled promptly.
  for (uint8_t i = 0; i < 8; i++) {
    unsigned char cmd;
    if (mouse.read(&cmd) != 0) break;
    mouse_command(cmd);
  }
}

// Enqueue movement packets in stream mode at most at sample rate
static void maybeEnqueueMovement() {
  if (!isIdentified) return;
  if (!isReporting) return;
  if (isRemoteMode) return;
  if (acc_dx == 0 && acc_dy == 0) return;

  unsigned long now = millis();
  if ((uint16_t)(now - lastSampleSentMs) < sampleIntervalMs) return;

  int dx = 0;
  int dy = 0;

  if (acc_dx != 0) {
    long v = acc_dx;
    if (v > 255) v = 255;
    if (v < -255) v = -255;
    dx = (int)v;
    acc_dx -= dx;
  }

  if (acc_dy != 0) {
    long v = acc_dy;
    if (v > 255) v = 255;
    if (v < -255) v = -255;
    dy = (int)v;
    acc_dy -= dy;
  }

  if (dx != 0 || dy != 0) {
    enqueueDataPacketInternal(dx, dy, false); // movement is low priority
    lastSampleSentMs = now;
  }
}

void setup() {
  Serial.begin(9600);
  Serial.flush();

  pinMode(PS2_CLOCK_PIN, INPUT_PULLUP);
  pinMode(PS2_DATA_PIN, INPUT_PULLUP);

  // IMPORTANT:
  // You have D5 (keyboard Arduino OUTPUT) wired directly to D5 (mouse Arduino INPUT).
  // With that, do NOT enable INPUT_PULLUP here; rely on the keyboard pin actively driving.
  // Ensure a common ground between the two boards (GND↔GND) so logic levels are valid.
  pinMode(POWER_STATUS_PIN, INPUT);

  // Initialize local state
  isIdentified = false;
  isInitialized = false;
  isPCPoweredOn = false;
  lastPowerStatus = false;
  isReporting = false;
  isRemoteMode = false;

  buttons[0] = buttons[1] = buttons[2] = 0;
  last_x = last_y = 0;
  acc_dx = acc_dy = 0;

  setSampleRate(100);
  lastSampleSentMs = millis();

  cmdLen = 0;
  txReset();
}

void loop() {
  // Check the power status (driven by keyboard Arduino pin 5)
  bool currentPowerStatus = (digitalRead(POWER_STATUS_PIN) == HIGH);
  if (currentPowerStatus != lastPowerStatus) {
    if (currentPowerStatus) {
      isPCPoweredOn = true;
#if FW_LOG_POWER_CHANGES
      Serial.println(F("mouse observed POWER_STATUS_PIN HIGH (PC power ON signal from keyboard)"));
#endif
    } else {
      isPCPoweredOn = false;
      isInitialized = false;
      isReporting = false; // safest default on power-off
      isRemoteMode = false;
      buttons[0] = buttons[1] = buttons[2] = 0;
      acc_dx = acc_dy = 0;
      last_x = last_y = 0;
#if FW_LOG_POWER_CHANGES
      Serial.println(F("mouse observed POWER_STATUS_PIN LOW (PC power OFF signal from keyboard)"));
#endif
    }
    lastPowerStatus = currentPowerStatus;
  }

  // 1) Always service serial input quickly (non-blocking)
  serviceSerial();

  // 2) Always service PS/2 host commands (do NOT gate)
  handlePS2Communication();

  // 3) In stream mode, rate-limit movement injection by host sample rate
  maybeEnqueueMovement();

  // 4) Pump outgoing PS/2 bytes (atomic frames; never partial-packet drop)
  txService();
}
