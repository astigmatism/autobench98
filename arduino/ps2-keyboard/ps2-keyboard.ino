#include "ps2dev.h"
#include <EEPROM.h>

#define ID "KB"
#define PS2_CLOCK_PIN 3
#define PS2_DATA_PIN 2
#define POWER_STATUS_PIN 5

PS2dev keyboard(PS2_CLOCK_PIN, PS2_DATA_PIN);

bool isIdentified = false;
bool isPCPoweredOn = false;
bool isInitialized = false;

// Track last transmitted byte for 0xFE (Resend)
unsigned char lastByte = 0x00;

// Track "current scan set" for logging / F0 00 query response.
// NOTE: Your injected scan codes are Set 2; this is for host-command handling visibility.
unsigned char currentScanSet = 0x02;

// --- Read-failure telemetry (avoid log spam + avoid making timing worse) ---
static unsigned long lastReadFailLogMs = 0;
static unsigned long readFailCount = 0;
static int lastReadFailRc = 0;
static unsigned char lastReadFailByte = 0x00;

// throttle window for repeated read failures
static const unsigned long READ_FAIL_LOG_THROTTLE_MS = 250;

// --------------------------------------------------------------------------
// Helpers (fast, low-allocation logging)
// --------------------------------------------------------------------------

static void printHex2(uint8_t b) {
  if (b < 0x10) Serial.print('0');
  Serial.print(b, HEX);
}

static const __FlashStringHelper* ps2CmdName(uint8_t cmd) {
  switch (cmd) {
    case 0xFF: return F("RESET");
    case 0xFE: return F("RESEND");
    case 0xF2: return F("READ_ID");
    case 0xED: return F("SET_LEDS");
    case 0xEE: return F("ECHO");
    case 0xF0: return F("SCAN_CODE_SET");
    case 0xF3: return F("TYPEMATIC_RATE_DELAY");
    case 0xF4: return F("ENABLE_SCANNING");
    case 0xF5: return F("DISABLE_SCANNING");
    case 0xF6: return F("SET_DEFAULTS");
    case 0xF7: return F("SET_ALL_KEYS_TYPEMATIC");
    case 0xF8: return F("SET_ALL_KEYS_MAKE_BREAK");
    case 0xF9: return F("SET_ALL_KEYS_MAKE");
    case 0xFA: return F("SET_ALL_KEYS_TYPEMATIC_MAKE_BREAK");
    case 0xFB: return F("SET_KEY_TYPE_TYPEMATIC");
    case 0xFC: return F("SET_KEY_TYPE_MAKE_BREAK");
    case 0xFD: return F("SET_KEY_TYPE_MAKE");
    default:   return F("UNKNOWN");
  }
}

static void logPS2Rx(uint8_t cmd) {
  // Preserve your existing prefix verbatim; append decode in parentheses.
  Serial.print(F("debug: keyboard sim recieved 0x"));
  printHex2(cmd);
  Serial.print(F(" ("));
  Serial.print(ps2CmdName(cmd));
  Serial.println(F(")"));
}

static void logPS2ReadFail(int rc, uint8_t maybeByte) {
  // READ FAILURE NOTE:
  // When keyboard.read(&command) returns rc != 0, the 'command' byte is NOT reliable.
  // In practice it is often still 0x00 simply because we initialized it to 0x00.
  // So the old log line ("recieved unknown: 00 ...") was misleading and extremely noisy.
  //
  // Also: printing to Serial inside a tight PS/2 loop adds overhead and can worsen timing,
  // which can create *more* read failures and spam.
  //
  // We still keep counters for later diagnostics, but we intentionally SILENCE the log
  // for now. If you need it back, re-enable the Serial prints below.
  readFailCount++;
  lastReadFailRc = rc;
  lastReadFailByte = maybeByte;

  // Throttle bookkeeping retained (in case you re-enable prints later).
  unsigned long nowMs = millis();
  if (nowMs - lastReadFailLogMs < READ_FAIL_LOG_THROTTLE_MS) return;
  lastReadFailLogMs = nowMs;

  // --- intentionally silenced ---
  // Serial.print(F("debug: keyboard sim recieved unknown: "));
  // printHex2(lastReadFailByte);
  // Serial.print(F(" (read failed rc="));
  // Serial.print(lastReadFailRc);
  // Serial.print(F("; byte unreliable; fails="));
  // Serial.print(readFailCount);
  // Serial.println(F(")"));
}

static void logLEDValue(uint8_t val) {
  bool scroll = (val & 0x01) != 0;
  bool num    = (val & 0x02) != 0;
  bool caps   = (val & 0x04) != 0;

  Serial.print(F("debug: LED arg=0x"));
  printHex2(val);
  Serial.print(F(" scroll="));
  Serial.print(scroll ? F("1") : F("0"));
  Serial.print(F(" num="));
  Serial.print(num ? F("1") : F("0"));
  Serial.print(F(" caps="));
  Serial.println(caps ? F("1") : F("0"));
}

static float typematicRateCps(uint8_t rateBits0to4) {
  static const float rates[32] = {
    30.0f, 26.7f, 24.0f, 21.8f, 20.7f, 18.5f, 17.1f, 16.0f,
    15.0f, 13.3f, 12.0f, 10.9f, 10.0f,  9.2f,  8.6f,  8.0f,
     7.5f,  6.7f,  6.0f,  5.5f,  5.0f,  4.6f,  4.3f,  4.0f,
     3.7f,  3.3f,  3.0f,  2.7f,  2.5f,  2.3f,  2.1f,  2.0f
  };
  return rates[rateBits0to4 & 0x1F];
}

static unsigned int typematicDelayMs(uint8_t delayBits5to6) {
  switch ((delayBits5to6 >> 5) & 0x03) {
    case 0: return 250;
    case 1: return 500;
    case 2: return 750;
    case 3: return 1000;
  }
  return 500;
}

// --------------------------------------------------------------------------
// Core
// --------------------------------------------------------------------------

void setup() {
  keyboard.keyboard_init();
  Serial.begin(9600);
  Serial.flush();

  pinMode(POWER_STATUS_PIN, OUTPUT);
  pinMode(PS2_CLOCK_PIN, INPUT_PULLUP);
  pinMode(PS2_DATA_PIN, INPUT_PULLUP);

  digitalWrite(POWER_STATUS_PIN, LOW);
  lastByte = 0x00;
  currentScanSet = 0x02;

  lastReadFailLogMs = 0;
  readFailCount = 0;
  lastReadFailRc = 0;
  lastReadFailByte = 0x00;
}

void loop() {
  // Monitor the PS/2 clock line to detect communication from the host
  if (digitalRead(PS2_CLOCK_PIN) == LOW) {
    handlePS2Communication();
  }

  // Process Serial Commands (unchanged command surface)
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "identify") {
      isIdentified = false;
      Serial.println(ID);
    }
    else if (!isIdentified && command == "identify_complete") {
      isIdentified = true;
      Serial.println(F("debug: keyboard identification complete"));
    }
    else if (isIdentified && command == "power_on") {
      isPCPoweredOn = true;
      digitalWrite(POWER_STATUS_PIN, HIGH);
      Serial.print(F("debug: keyboard accepts power ON command, sets PIN "));
      Serial.print(POWER_STATUS_PIN);
      Serial.println(F(" to HIGH"));
    }
    else if (isIdentified && command == "power_off") {
      isPCPoweredOn = false;
      isInitialized = false;
      digitalWrite(POWER_STATUS_PIN, LOW);
      Serial.print(F("debug: keyboard accepts power OFF command, sets PIN "));
      Serial.print(POWER_STATUS_PIN);
      Serial.println(F(" to LOW"));
    }
    else if (isIdentified) {
      int spaceIndex = command.indexOf(' ');
      if (spaceIndex <= 0) {
        Serial.print(F("debug: command is "));
        Serial.print(command);
        Serial.println(F(". nothing to do"));
        return;
      }

      String action = command.substring(0, spaceIndex);
      String scanCodeStr = command.substring(spaceIndex + 1);
      int colonIndex = scanCodeStr.indexOf(':');

      unsigned char prefix = 0x00;
      unsigned char scanCode = 0x00;

      if (colonIndex != -1) {
        String prefixStr = scanCodeStr.substring(0, colonIndex);
        prefix = (unsigned char)strtol(prefixStr.c_str(), NULL, 16);
        scanCodeStr = scanCodeStr.substring(colonIndex + 1);
      }
      scanCode = (unsigned char)strtol(scanCodeStr.c_str(), NULL, 16);

      if (action == "press" || action == "hold" || action == "release") {
        if (action == "press" || action == "hold") {
          if (prefix != 0x00) keyboard.keyboard_press(prefix);
          keyboard.keyboard_press(scanCode);

          if (action == "press") {
            delay(100);
            if (prefix != 0x00) keyboard.keyboard_release(prefix);
            keyboard.keyboard_release(scanCode);
          }
        } else if (action == "release") {
          if (prefix != 0x00) keyboard.keyboard_release(prefix);
          keyboard.keyboard_release(scanCode);
        }

        Serial.print(F("success: "));
        Serial.print(action);
        Serial.print(F(" command for scan code "));
        Serial.println(scanCode, HEX);
      }
    }
    else {
      Serial.print(F("debug: command is "));
      Serial.print(command);
      Serial.println(F(". nothing to do"));
    }
  }
}

void handlePS2Communication() {
  unsigned char command = 0x00;
  int rc = keyboard.read(&command);

  if (rc == 0) {
    logPS2Rx(command);
    keyboard_command(command);
  } else {
    // Read failed; 'command' byte is unreliable (see logPS2ReadFail comment).
    logPS2ReadFail(rc, command);
  }
}

void keyboard_command(unsigned char command) {
  unsigned char val = 0x00;

  switch (command) {
    case 0xFF: // Reset
      Serial.println(F("debug: handling reset command"));
      ack();
      delay(600);
      while (keyboard.write(0xAA) != 0) delay(1);
      Serial.println(F("debug: sent BAT success"));
      lastByte = 0xAA;
      break;

    case 0xFE: // Resend
      Serial.println(F("debug: handling resend command"));
      keyboard.write(lastByte);
      break;

    case 0xF2: { // Identify
      Serial.println(F("debug: handling identify command"));
      ack();

      int retryCount = 0;
      const int maxRetries = 100;

      // Attempt to send 0xAB 0x83 (device ID)
      do {
        if (keyboard.write(0xAB) == 0) {
          lastByte = 0xAB;
          if (keyboard.write(0x83) == 0) {
            lastByte = 0x83;
            Serial.println(F("debug: sent device id bytes 0xAB 0x83"));
            break;
          }
        }
        retryCount++;
        delay(1);
      } while (retryCount < maxRetries);

      if (retryCount >= maxRetries) {
        Serial.println(F("debug: failed to send device id bytes within retry budget"));
      }
      break;
    }

    case 0xED: // Set/Reset LEDs (expects one argument byte)
      Serial.println(F("debug: handling set/reset LEDs command"));
      ack();
      if (keyboard.read(&val) == 0) {
        ack();
        logLEDValue(val);
      } else {
        Serial.println(F("debug: LED argument read failed (no reliable byte)"));
      }
      Serial.println(F("debug: keyboard sim sent LED state change"));
      break;

    case 0xEE: // Echo
      Serial.println(F("debug: keyboard sim handling echo"));
      keyboard.write(0xEE);
      lastByte = 0xEE;
      break;

    case 0xF0: // Set scan code set (expects one argument byte)
      Serial.println(F("debug: keyboard sim handling scan code set"));
      ack();
      if (keyboard.read(&val) == 0) {
        // Host sent an argument; ack it.
        ack();

        if (val == 0x00) {
          // If argument is 0x00, respond with current scan code set.
          while (keyboard.write(currentScanSet) != 0) delay(1);
          lastByte = currentScanSet;

          Serial.print(F("debug: scan code set query; replied current=0x"));
          printHex2(currentScanSet);
          Serial.println();
        } else {
          // Record for visibility. NOTE: your injected scan codes remain Set 2.
          currentScanSet = val;

          Serial.print(F("debug: scan code set requested=0x"));
          printHex2(val);
          Serial.println(F(" (note: injected scan codes are Set 2)"));
        }
      } else {
        Serial.println(F("debug: scan code set argument read failed (no reliable byte)"));
      }
      break;

    case 0xF3: // Set typematic rate/delay (expects one argument byte)
      Serial.println(F("debug: keyboard sim handling typematic rate"));
      ack();
      if (keyboard.read(&val) == 0) {
        ack();

        uint8_t rateBits = val & 0x1F;
        float rate = typematicRateCps(rateBits);
        unsigned int delayMs = typematicDelayMs(val);

        Serial.print(F("debug: typematic arg=0x"));
        printHex2(val);
        Serial.print(F(" delayMs="));
        Serial.print(delayMs);
        Serial.print(F(" rateCps="));
        Serial.println(rate, 1);
      } else {
        Serial.println(F("debug: typematic argument read failed (no reliable byte)"));
      }
      break;

    case 0xF4: // Enable data reporting
      Serial.println(F("debug: keyboard handling enable scanning"));
      ack();
      break;

    case 0xF5: // Disable data reporting
      Serial.println(F("debug: keyboard handling disable scanning"));
      ack();
      break;

    case 0xF6: // Set defaults
      Serial.println(F("debug: keyboard set defaults"));
      ack();
      currentScanSet = 0x02;
      break;

    // Valid host commands per common references; we ACK only.
    case 0xF7:
    case 0xF8:
    case 0xF9:
    case 0xFA:
    case 0xFB:
    case 0xFC:
    case 0xFD:
      Serial.print(F("debug: handling key-type command 0x"));
      printHex2(command);
      Serial.println(F(" (ACK only)"));
      ack();
      break;

    default:
      // Preserve your existing behavior: ACK even if unknown.
      Serial.print(F("debug: received unknown command "));
      Serial.println(command, HEX);
      ack();
      break;
  }
}

void ack() {
  Serial.println(F("debug: acknowledge"));
  while (keyboard.write(0xFA) != 0) delay(1);
  lastByte = 0xFA;
}
