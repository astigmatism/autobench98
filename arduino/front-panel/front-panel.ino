#include <Arduino.h>
#include <U8g2lib.h>

// =====================
// Pin definitions
// =====================

// Define pins for power, reset buttons, and power sense
#define ID "FP"
#define POWER_SENSE_PIN 2
#define POWER_BUTTON_PIN 3
#define RESET_BUTTON_PIN 4
#define OVERRIDE_POWER_BUTTON_PIN 5

// HDD activity sense (requires external conditioning: opto/SSR/etc. -> clean digital pulses)
#define HDD_SENSE_PIN 7

// OLED (software I2C on spare right-side pins)
#define OLED_SCL_PIN 14
#define OLED_SDA_PIN 15

#define DEBOUNCE_DELAY 500       // debounce time in milliseconds (power sense)
#define HDD_COOLDOWN_MS 200      // activity "linger" window to prevent serial spam
#define OLED_MIN_REFRESH_MS 200  // avoid redrawing constantly

// How long to show "PULSE/OVRD" after a momentary press (display only)
#define BTN_PULSE_WINDOW_MS 350

// OLED layout (128x64): 5 lines, evenly spaced (baseline positions)
#define OLED_Y1 12
#define OLED_LINE_SPACING 12

// =====================
// Global state
// =====================

bool isIdentified = false;
bool powerButtonlock = false;  // Lock to prevent interference
bool commandLock = false;      // Lock to prevent interference

volatile unsigned long lastPowerLEDInterruptTime = 0;
volatile bool powerLedStateChanged = false;  // Flag to indicate a state change

bool powerButtonHeld = false;  // Tracks if power button is held

// HDD activity capture: count edges in ISR; collapse to ON/OFF via cooldown window
volatile uint32_t hddEdgeCount = 0;
uint32_t lastHddEdgeCountHandled = 0;
unsigned long lastHddActivityMs = 0;
bool hddActive = false;

// Power state cache (for display + reduced redraw churn)
bool pcPowerOnCached = false;

// Button pulse timestamps (for display only)
unsigned long lastPowerPulseMs = 0;
unsigned long lastResetPulseMs = 0;

// Track whether the last power pulse came from the OVERRIDE button
bool lastPowerPulseWasOverride = false;

// Display state
static bool displayDirty = true;
static unsigned long lastDisplayUpdateMs = 0;

// LAST: keep it short and deterministic; avoid heap churn.
static char lastLabel[24] = "BOOT";

// =====================
// OLED (U8g2) setup
// Page-buffer mode to reduce SRAM use.
// =====================

U8G2_SSD1306_128X64_NONAME_1_SW_I2C u8g2(
  U8G2_R0,
  OLED_SCL_PIN,
  OLED_SDA_PIN,
  U8X8_PIN_NONE
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
  if (label != nullptr) {
    setLastLabel(label);
  }
  displayDirty = true;
}

static const char* powerButtonStatus() {
  const unsigned long now = millis();
  if (powerButtonHeld) return "HELD";
  if (lastPowerPulseMs != 0 && (now - lastPowerPulseMs) < BTN_PULSE_WINDOW_MS) {
    return lastPowerPulseWasOverride ? "OVRD" : "PULSE";
  }
  return "OFF";
}

static const char* resetButtonStatus() {
  const unsigned long now = millis();
  if (lastResetPulseMs != 0 && (now - lastResetPulseMs) < BTN_PULSE_WINDOW_MS) return "PULSE";
  return "OFF";
}

// =====================
// ISRs
// =====================

void handlePowerLedChange() {
  lastPowerLEDInterruptTime = millis();
  powerLedStateChanged = true;
}

void handleHddSenseChange() {
  // Keep ISR minimal: just count edges. Do not call Serial or delay here.
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
  const uint8_t y5 = y4 + OLED_LINE_SPACING; // ends at 60 with defaults

  u8g2.setFont(u8g2_font_6x10_tf);

  // 1) Power sense
  u8g2.setCursor(0, y1);
  u8g2.print("PWR_SNS: ");
  u8g2.print(pcPowerOnCached ? "ON" : "OFF");

  // 2) Power button status
  u8g2.setCursor(0, y2);
  u8g2.print("PWR_btn: ");
  u8g2.print(powerButtonStatus());

  // 3) Reset button status
  u8g2.setCursor(0, y3);
  u8g2.print("RST_btn: ");
  u8g2.print(resetButtonStatus());

  // 4) HDD activity
  u8g2.setCursor(0, y4);
  u8g2.print("HDD_ACT: ");
  u8g2.print(hddActive ? "ACT" : "INACT");

  // 5) Last command/event label
  u8g2.setCursor(0, y5);
  u8g2.print("LAST: ");
  u8g2.print(lastLabel);
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
// HDD telemetry + events
// =====================

static void processHddActivityTelemetry() {
  // Pull a stable snapshot of the edge counter
  uint32_t edgesNow = 0;
  noInterrupts();
  edgesNow = hddEdgeCount;
  interrupts();

  // If new edges happened, treat that as activity "now"
  if (edgesNow != lastHddEdgeCountHandled) {
    lastHddEdgeCountHandled = edgesNow;
    lastHddActivityMs = millis();
  }

  const unsigned long now = millis();
  const bool activeNow = (lastHddActivityMs != 0) && ((now - lastHddActivityMs) < HDD_COOLDOWN_MS);

  // Keep the serial behavior intact: only emit HDD ON/OFF after identify_complete
  if (!isIdentified) {
    hddActive = false;
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
// Button helpers
// =====================

// Simulate a momentary button press with inverted logic
void simulateButtonPress(int buttonPin, bool fromOverride = false) {
  const unsigned long now = millis();

  if (buttonPin == POWER_BUTTON_PIN) {
    lastPowerPulseMs = now;
    lastPowerPulseWasOverride = fromOverride;
  } else if (buttonPin == RESET_BUTTON_PIN) {
    lastResetPulseMs = now;
  }

  // Press
  digitalWrite(buttonPin, HIGH);
  delay(100);
  // Release
  digitalWrite(buttonPin, LOW);

  displayDirty = true;
}

// Hold the power button (inverted logic)
void holdPowerButton() {
  digitalWrite(POWER_BUTTON_PIN, HIGH);
  powerButtonHeld = true;
  displayDirty = true;
}

// Release the power button (inverted logic)
void releasePowerButton() {
  if (powerButtonHeld) {
    digitalWrite(POWER_BUTTON_PIN, LOW);
    powerButtonHeld = false;
    displayDirty = true;
  }
}

// =====================
// Setup
// =====================

void setup() {
  Serial.begin(9600);

  pinMode(POWER_BUTTON_PIN, OUTPUT);
  pinMode(RESET_BUTTON_PIN, OUTPUT);  // inverted logic in this design
  pinMode(POWER_SENSE_PIN, INPUT_PULLUP);
  pinMode(OVERRIDE_POWER_BUTTON_PIN, INPUT_PULLUP);

  pinMode(HDD_SENSE_PIN, INPUT_PULLUP);

  digitalWrite(POWER_BUTTON_PIN, LOW);
  digitalWrite(RESET_BUTTON_PIN, LOW);

  // Interrupts
  attachInterrupt(digitalPinToInterrupt(POWER_SENSE_PIN), handlePowerLedChange, CHANGE);

  const int hddInterrupt = digitalPinToInterrupt(HDD_SENSE_PIN);
  if (hddInterrupt != NOT_AN_INTERRUPT) {
    attachInterrupt(hddInterrupt, handleHddSenseChange, CHANGE);
  } else {
    Serial.println("debug: HDD_SENSE_PIN has no external interrupt; HDD activity may be missed");
  }

  // OLED init
  u8g2.begin();

  // Initialize cached power sense immediately for the display
  pcPowerOnCached = (digitalRead(POWER_SENSE_PIN) == LOW);

  markDisplayDirty("BOOT");
  maybeUpdateDisplay(true);
}

// =====================
// Main loop
// =====================

void loop() {
  // Process Serial Commands
  if (Serial.available()) {
    commandLock = true;
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "identify") {
      isIdentified = false;
      Serial.println(ID);
      markDisplayDirty("identify");
    } else if (!isIdentified && command == "identify_complete") {
      isIdentified = true;
      Serial.println("debug: front panel identification complete, sending client power state");

      pcPowerOnCached = (digitalRead(POWER_SENSE_PIN) == LOW);
      Serial.print("POWER_LED_");
      Serial.println(pcPowerOnCached ? "ON" : "OFF");

      Serial.println("HDD_ACTIVE_OFF");
      hddActive = false;
      lastHddActivityMs = 0;
      lastHddEdgeCountHandled = 0;
      noInterrupts();
      hddEdgeCount = 0;
      interrupts();

      markDisplayDirty("id_complete");
    } else if (isIdentified && command == "POWER_HOLD") {
      holdPowerButton();
      Serial.println("debug: front panel power button held");
      markDisplayDirty("POWER_HOLD");
    } else if (isIdentified && command == "POWER_RELEASE") {
      releasePowerButton();
      Serial.println("debug: front panel power button released");
      markDisplayDirty("POWER_RELEASE");
    } else if (isIdentified && command == "RESET_HOLD") {
      simulateButtonPress(RESET_BUTTON_PIN, false);
      Serial.println("debug: front panel reset button held");
      markDisplayDirty("RESET_HOLD");
    } else if (isIdentified && command == "RESET_RELEASE") {
      Serial.println("debug: front panel reset button released");
      markDisplayDirty("RESET_RELEASE");
    }
  }
  // Handle PowerSense state changes (debounced)
  else if (!commandLock && powerLedStateChanged &&
           ((millis() - lastPowerLEDInterruptTime) > DEBOUNCE_DELAY)) {

    pcPowerOnCached = (digitalRead(POWER_SENSE_PIN) == LOW);

    // Keep serial behavior: only emit POWER_LED_... after identify_complete
    if (isIdentified) {
      Serial.print("POWER_LED_");
      Serial.println(pcPowerOnCached ? "ON" : "OFF");
    }

    powerLedStateChanged = false;
    displayDirty = true;
  }
  // Handle Override Button
  else if (isIdentified && !commandLock && !powerButtonlock &&
           digitalRead(OVERRIDE_POWER_BUTTON_PIN) == LOW) {

    simulateButtonPress(POWER_BUTTON_PIN, true);
    markDisplayDirty("override");
  }

  // HDD telemetry (edge capture in ISR; ON/OFF collapse here)
  processHddActivityTelemetry();

  // OLED refresh (rate-limited)
  maybeUpdateDisplay(false);

  commandLock = false;
}
