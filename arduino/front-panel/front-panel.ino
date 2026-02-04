#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// =====================
// Pin definitions (UPDATED MAPPING)
// =====================

#define ID "FP"

// OLED uses HW I2C on ATmega32U4; these are informational for this build.
// HW I2C pins are determined by the board core/variant.
#define OLED_SDA_PIN 2
#define OLED_SCL_PIN 3

// PowerSense (PC817 output -> clean digital level)
#define POWER_SENSE_PIN 6

// Motherboard button drives (AQY212EH inputs via resistors)
#define RESET_BUTTON_PIN 8
#define POWER_BUTTON_PIN 9

// Local override pushbutton (to GND, uses INPUT_PULLUP)
#define OVERRIDE_POWER_BUTTON_PIN 15

// HDD activity sense (H11AA1 output -> clean digital pulses)
#define HDD_SENSE_PIN 7

#define DEBOUNCE_DELAY 500        // debounce time in ms (power sense)
#define HDD_COOLDOWN_MS 200       // activity "linger" window to prevent serial spam
#define OLED_MIN_REFRESH_MS 200   // avoid redrawing constantly

// Display-only windows
#define RST_PULSE_WINDOW_MS 350
#define PWR_PULSE_WINDOW_MS 350

// Button pulse width (non-blocking)
#define BUTTON_PULSE_MS 100

// Small guard window after processing any serial command
#define COMMAND_LOCK_MS 150

// OLED layout (128x64): 5 lines, evenly spaced (baseline positions)
#define OLED_Y1 12
#define OLED_LINE_SPACING 12

// =====================
// Safety: max hold timeout (REQUIREMENT)
// =====================
// Global variable (not a #define): maximum time a HOLD can persist without RELEASE.
const unsigned long MAX_HOLD_MS = 10000UL; // 10 seconds

// =====================
// Global state
// =====================

bool isIdentified = false;

bool powerHeld = false; // host POWER_HOLD
bool resetHeld = false; // host RESET_HOLD

// HOLD lease timers (auto-release if expired)
static unsigned long powerHoldUntilMs = 0;
static unsigned long resetHoldUntilMs = 0;

// Display status flags for auto-release events (persist until next explicit state change)
static bool powerAutoReleased = false;
static bool resetAutoReleased = false;

// Non-blocking pulse scheduler state
static bool powerPulseActive = false;
static unsigned long powerPulseUntilMs = 0;
static unsigned long lastPowerPulseMs = 0;

static bool resetPulseActive = false;
static unsigned long resetPulseUntilMs = 0;
static unsigned long lastResetPulseMs = 0;

// Guard window after command processing
static unsigned long commandLockUntilMs = 0;

// HDD activity capture: count edges in ISR; collapse to ON/OFF via cooldown window
volatile uint32_t hddEdgeCount = 0;
uint32_t lastHddEdgeCountHandled = 0;
unsigned long lastHddActivityMs = 0;
bool hddActive = false;

// Power state cache (for display + reduced redraw churn)
// Convention: PowerSense opto ON pulls pin LOW -> pcPowerOnCached = true when read LOW
bool pcPowerOnCached = false;

// PowerSense debounce tracking (polling-based)
static bool powerSenseRaw = false;
static bool powerSenseStable = false;
static unsigned long powerSenseRawChangedMs = 0;
static bool powerSenseInit = false;

// Override button tracking (edge detect)
bool overrideDown = false;
bool overrideDownPrev = false;

// Display state
static bool displayDirty = true;
static unsigned long lastDisplayUpdateMs = 0;

// LAST: keep it short and deterministic; avoid heap churn.
static char lastLabel[24] = "BOOT";

// =====================
// OLED (U8g2) setup
// =====================

U8G2_SSD1306_128X64_NONAME_1_HW_I2C u8g2(
  U8G2_R0,
  /* reset = */ U8X8_PIN_NONE
);

// =====================
// Helpers
// =====================

static void setLastLabel(const char* s) {
  size_t i = 0;
  for (; i < (sizeof(lastLabel) - 1) && s[i] != '\0'; i++) {
    lastLabel[i] = s[i];
  }
  lastLabel[i] = '\0';
}

static void markDisplayDirty(const char* label = nullptr) {
  if (label != nullptr) setLastLabel(label);
  displayDirty = true;
}

static void updateButtonOutputs() {
  const bool powerOut = (powerHeld || powerPulseActive);
  const bool resetOut = (resetHeld || resetPulseActive);

  // Inverted logic at the motherboard side is handled by the AQY212EH; here:
  // HIGH = "press" LED on PhotoMOS input, LOW = release.
  digitalWrite(POWER_BUTTON_PIN, powerOut ? HIGH : LOW);
  digitalWrite(RESET_BUTTON_PIN, resetOut ? HIGH : LOW);
}

static void clearPowerAutoState() { powerAutoReleased = false; }
static void clearResetAutoState() { resetAutoReleased = false; }

static void schedulePowerPulse() {
  const unsigned long now = millis();
  if (powerHeld) return; // don't interfere with a host hold

  powerPulseActive = true;
  powerPulseUntilMs = now + BUTTON_PULSE_MS;
  lastPowerPulseMs = now;

  clearPowerAutoState();

  updateButtonOutputs();
  markDisplayDirty("PWR_PULSE");
}

static void scheduleResetPulse() {
  const unsigned long now = millis();
  if (resetHeld) return; // don't interfere with a host hold

  resetPulseActive = true;
  resetPulseUntilMs = now + BUTTON_PULSE_MS;
  lastResetPulseMs = now;

  clearResetAutoState();

  updateButtonOutputs();
  markDisplayDirty("RST_PULSE");
}

static void processButtonPulses() {
  const unsigned long now = millis();

  if (powerPulseActive && (long)(now - powerPulseUntilMs) >= 0) {
    powerPulseActive = false;
    updateButtonOutputs();
    displayDirty = true;
  }

  if (resetPulseActive && (long)(now - resetPulseUntilMs) >= 0) {
    resetPulseActive = false;
    updateButtonOutputs();
    displayDirty = true;
  }
}

static void processHoldTimeouts() {
  const unsigned long now = millis();

  if (powerHeld && powerHoldUntilMs != 0 && (long)(now - powerHoldUntilMs) >= 0) {
    // Auto-release POWER
    powerHeld = false;
    powerHoldUntilMs = 0;
    powerAutoReleased = true;

    updateButtonOutputs();

    if (isIdentified) {
      Serial.println("debug: POWER_HOLD auto-released (timeout)");
    }
    markDisplayDirty("PWR_AUTO");
  }

  if (resetHeld && resetHoldUntilMs != 0 && (long)(now - resetHoldUntilMs) >= 0) {
    // Auto-release RESET
    resetHeld = false;
    resetHoldUntilMs = 0;
    resetAutoReleased = true;

    updateButtonOutputs();

    if (isIdentified) {
      Serial.println("debug: RESET_HOLD auto-released (timeout)");
    }
    markDisplayDirty("RST_AUTO");
  }
}

static const char* pwrBtnStatus() {
  const unsigned long now = millis();
  if (powerHeld) return "HELD";                        // output held by host (lease active)
  if (overrideDown) return "DOWN";                     // physical button currently down
  if (lastPowerPulseMs != 0 && (now - lastPowerPulseMs) < PWR_PULSE_WINDOW_MS) return "PULSE";
  if (powerAutoReleased) return "AUTO";                // released automatically due to timeout
  return "OFF";
}

static const char* rstBtnStatus() {
  const unsigned long now = millis();
  if (resetHeld) return "HELD";                        // output held by host (lease active)
  if (lastResetPulseMs != 0 && (now - lastResetPulseMs) < RST_PULSE_WINDOW_MS) return "PULSE";
  if (resetAutoReleased) return "AUTO";                // released automatically due to timeout
  return "OFF";
}

// Trim leading/trailing whitespace in-place
static void trimInPlace(char* s) {
  // leading
  size_t start = 0;
  while (s[start] == ' ' || s[start] == '\t') start++;

  if (start > 0) {
    size_t i = 0;
    while (s[start + i] != '\0') {
      s[i] = s[start + i];
      i++;
    }
    s[i] = '\0';
  }

  // trailing
  size_t len = 0;
  while (s[len] != '\0') len++;
  while (len > 0 && (s[len - 1] == ' ' || s[len - 1] == '\t')) {
    s[len - 1] = '\0';
    len--;
  }
}

// =====================
// ISRs
// =====================

void handleHddSenseChange() {
  hddEdgeCount++;
}

// =====================
// Display helpers
// =====================

static void drawDisplayPage() {
  const uint8_t y1 = OLED_Y1;
  const uint8_t y2 = y1 + OLED_LINE_SPACING;
  const uint8_t y3 = y2 + OLED_LINE_SPACING;
  const uint8_t y4 = y3 + OLED_LINE_SPACING;
  const uint8_t y5 = y4 + OLED_LINE_SPACING;

  u8g2.setFont(u8g2_font_6x10_tf);

  // 1) Last command/event label (MOVED TO FIRST ROW)
  u8g2.setCursor(0, y1);
  u8g2.print("LAST: ");
  u8g2.print(lastLabel);

  // 2) Power sense
  u8g2.setCursor(0, y2);
  u8g2.print("PWR_SNS: ");
  u8g2.print(pcPowerOnCached ? "ON" : "OFF");

  // 3) Power button status
  u8g2.setCursor(0, y3);
  u8g2.print("PWR_BTN: ");
  u8g2.print(pwrBtnStatus());

  // 4) Reset button status
  u8g2.setCursor(0, y4);
  u8g2.print("RST_BTN: ");
  u8g2.print(rstBtnStatus());

  // 5) HDD activity
  u8g2.setCursor(0, y5);
  u8g2.print("HDD_ACT: ");
  u8g2.print(hddActive ? "ON" : "OFF");
}

static void maybeUpdateDisplay(bool force = false) {
  const unsigned long now = millis();
  if (!force) {
    if (!displayDirty) return;
    if ((now - lastDisplayUpdateMs) < OLED_MIN_REFRESH_MS) return;
  }

  u8g2.firstPage();
  do {
    drawDisplayPage();
  } while (u8g2.nextPage());

  lastDisplayUpdateMs = now;
  displayDirty = false;
}

// =====================
// PowerSense telemetry (poll + debounce)
// =====================

static void processPowerSenseTelemetry() {
  const unsigned long now = millis();
  const bool rawOn = (digitalRead(POWER_SENSE_PIN) == LOW);

  if (!powerSenseInit) {
    powerSenseInit = true;
    powerSenseRaw = rawOn;
    powerSenseStable = rawOn;
    powerSenseRawChangedMs = now;
    pcPowerOnCached = rawOn;
    return;
  }

  if (rawOn != powerSenseRaw) {
    powerSenseRaw = rawOn;
    powerSenseRawChangedMs = now;
  }

  if ((now - powerSenseRawChangedMs) >= DEBOUNCE_DELAY && powerSenseStable != powerSenseRaw) {
    powerSenseStable = powerSenseRaw;
    pcPowerOnCached = powerSenseStable;

    if (isIdentified) {
      Serial.print("POWER_LED_");
      Serial.println(pcPowerOnCached ? "ON" : "OFF");
    }

    displayDirty = true;
  }
}

// =====================
// HDD telemetry + events
// =====================

static void processHddActivityTelemetry() {
  uint32_t edgesNow = 0;
  noInterrupts();
  edgesNow = hddEdgeCount;
  interrupts();

  if (edgesNow != lastHddEdgeCountHandled) {
    lastHddEdgeCountHandled = edgesNow;
    lastHddActivityMs = millis();
  }

  const unsigned long now = millis();
  const bool activeNow = (lastHddActivityMs != 0) && ((now - lastHddActivityMs) < HDD_COOLDOWN_MS);

  if (!isIdentified) {
    if (hddActive) {
      hddActive = false;
      displayDirty = true;
    }
    return;
  }

  if (activeNow && !hddActive) {
    hddActive = true;
    Serial.println("HDD_ACTIVE_ON");
    displayDirty = true;
  } else if (!activeNow && hddActive) {
    hddActive = false;
    Serial.println("HDD_ACTIVE_OFF");
    displayDirty = true;
  }
}

// =====================
// Serial command handling (non-blocking, no String)
// =====================

static void handleCommand(const char* cmd) {
  const unsigned long now = millis();
  commandLockUntilMs = now + COMMAND_LOCK_MS;

  if (strcmp(cmd, "identify") == 0) {
    isIdentified = false;
    Serial.println(ID);
    markDisplayDirty("identify");
    return;
  }

  if (!isIdentified && strcmp(cmd, "identify_complete") == 0) {
    isIdentified = true;
    Serial.println("debug: front panel identification complete, sending client power state");

    // Baseline outputs safe-low + clear safety timers/flags
    powerHeld = false;
    resetHeld = false;
    powerHoldUntilMs = 0;
    resetHoldUntilMs = 0;
    powerAutoReleased = false;
    resetAutoReleased = false;

    powerPulseActive = false;
    resetPulseActive = false;
    updateButtonOutputs();

    // Send current PowerSense state immediately
    pcPowerOnCached = (digitalRead(POWER_SENSE_PIN) == LOW);
    Serial.print("POWER_LED_");
    Serial.println(pcPowerOnCached ? "ON" : "OFF");

    // Reset PowerSense debounce baseline so we don't immediately re-emit
    powerSenseInit = false;

    // Provide a baseline HDD state
    Serial.println("HDD_ACTIVE_OFF");
    hddActive = false;
    lastHddActivityMs = 0;
    lastHddEdgeCountHandled = 0;
    noInterrupts();
    hddEdgeCount = 0;
    interrupts();

    markDisplayDirty("id_complete");
    return;
  }

  if (!isIdentified) return;

  if (strcmp(cmd, "POWER_HOLD") == 0) {
    powerHeld = true;
    powerHoldUntilMs = now + MAX_HOLD_MS;   // start/refresh lease timer
    clearPowerAutoState();

    updateButtonOutputs();
    Serial.println("debug: front panel power button held");
    markDisplayDirty("POWER_HOLD");
    return;
  }

  if (strcmp(cmd, "POWER_RELEASE") == 0) {
    powerHeld = false;
    powerHoldUntilMs = 0;
    clearPowerAutoState();

    updateButtonOutputs();
    Serial.println("debug: front panel power button released");
    markDisplayDirty("POWER_RELEASE");
    return;
  }

  if (strcmp(cmd, "RESET_HOLD") == 0) {
    resetHeld = true;
    resetHoldUntilMs = now + MAX_HOLD_MS;   // start/refresh lease timer
    clearResetAutoState();

    updateButtonOutputs();
    Serial.println("debug: front panel reset button held");
    markDisplayDirty("RESET_HOLD");
    return;
  }

  if (strcmp(cmd, "RESET_RELEASE") == 0) {
    resetHeld = false;
    resetHoldUntilMs = 0;
    clearResetAutoState();

    updateButtonOutputs();
    Serial.println("debug: front panel reset button released");
    markDisplayDirty("RESET_RELEASE");
    return;
  }

  // Optional backward-compatible pulses (if you ever want them from host)
  // if (strcmp(cmd, "POWER_PULSE") == 0) { schedulePowerPulse(); return; }
  // if (strcmp(cmd, "RESET_PULSE") == 0) { scheduleResetPulse(); return; }
}

static void processSerial() {
  static char buf[64];
  static size_t len = 0;

  while (Serial.available() > 0) {
    const char c = (char)Serial.read();

    if (c == '\r') {
      continue;
    }

    if (c == '\n') {
      buf[len] = '\0';
      trimInPlace(buf);
      if (buf[0] != '\0') {
        handleCommand(buf);
      }
      len = 0;
      continue;
    }

    if (len < (sizeof(buf) - 1)) {
      buf[len++] = c;
    } else {
      // overflow: drop line
      len = 0;
    }
  }
}

// =====================
// Setup
// =====================

void setup() {
  Serial.begin(9600);

  pinMode(POWER_BUTTON_PIN, OUTPUT);
  pinMode(RESET_BUTTON_PIN, OUTPUT);
  pinMode(POWER_SENSE_PIN, INPUT_PULLUP);
  pinMode(OVERRIDE_POWER_BUTTON_PIN, INPUT_PULLUP);
  pinMode(HDD_SENSE_PIN, INPUT_PULLUP);

  // Start safe-low
  digitalWrite(POWER_BUTTON_PIN, LOW);
  digitalWrite(RESET_BUTTON_PIN, LOW);

  // HDD interrupt
  const int hddInterrupt = digitalPinToInterrupt(HDD_SENSE_PIN);
  if (hddInterrupt != NOT_AN_INTERRUPT) {
    attachInterrupt(hddInterrupt, handleHddSenseChange, CHANGE);
  } else {
    Serial.println("debug: HDD_SENSE_PIN has no external interrupt; HDD activity may be missed");
  }

  // OLED init (HW I2C)
  u8g2.begin();

  // Initialize cached power sense immediately for the display
  pcPowerOnCached = (digitalRead(POWER_SENSE_PIN) == LOW);
  powerSenseInit = false;

  // Initialize override state
  overrideDown = (digitalRead(OVERRIDE_POWER_BUTTON_PIN) == LOW);
  overrideDownPrev = overrideDown;

  // Clear safety state
  powerHoldUntilMs = 0;
  resetHoldUntilMs = 0;
  powerAutoReleased = false;
  resetAutoReleased = false;

  markDisplayDirty("BOOT");
  maybeUpdateDisplay(true);
}

// =====================
// Main loop
// =====================

void loop() {
  // Non-blocking pulse expirations
  processButtonPulses();

  // Always sample override button (for display + edge detection)
  overrideDown = (digitalRead(OVERRIDE_POWER_BUTTON_PIN) == LOW);
  if (overrideDown != overrideDownPrev) {
    displayDirty = true;
    overrideDownPrev = overrideDown;
  }

  // Serial commands (non-blocking)
  processSerial();

  // Safety: auto-release holds if they exceed MAX_HOLD_MS
  processHoldTimeouts();

  // Physical override: one motherboard pulse per press (only when identified)
  const unsigned long now = millis();
  const bool commandLocked = (now < commandLockUntilMs);

  if (isIdentified && !commandLocked && !powerHeld) {
    static bool overrideFiredForThisPress = false;

    if (overrideDown && !overrideFiredForThisPress) {
      overrideFiredForThisPress = true;
      schedulePowerPulse();
      markDisplayDirty("override");
    } else if (!overrideDown && overrideFiredForThisPress) {
      overrideFiredForThisPress = false;
    }
  }

  // PowerSense (polled + debounced)
  processPowerSenseTelemetry();

  // HDD telemetry
  processHddActivityTelemetry();

  // OLED refresh (rate-limited)
  maybeUpdateDisplay(false);
}
