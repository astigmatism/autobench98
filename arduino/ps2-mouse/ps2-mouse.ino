#include <ps2dev.h>
#include <EEPROM.h>

#define ID "MS"
#define PS2_CLOCK_PIN 3
#define PS2_DATA_PIN 2
#define POWER_STATUS_PIN 5

PS2dev mouse(PS2_CLOCK_PIN, PS2_DATA_PIN);

bool isIdentified = false;
bool isInitialized = false;
bool isPCPoweredOn = false;
bool lastPowerStatus = false;
bool isReporting = false; // enabled via PS/2 command (0xF4)

// buttons[0]=left, buttons[1]=right, buttons[2]=middle
char buttons[3] = {0, 0, 0};
int delta_x = 0;
int delta_y = 0;
int last_x = 0;
int last_y = 0;

// --- bounded write retry (prevents silent packet drops) ---
static unsigned long lastWriteFailLogMs = 0;
static const unsigned long WRITE_FAIL_LOG_THROTTLE_MS = 250;

static bool writeByteWithRetry(uint8_t b, unsigned long timeoutMs = 10) {
  unsigned long start = millis();
  while (true) {
    int rc = mouse.write(b);
    if (rc == 0) return true;

    if (millis() - start >= timeoutMs) return false;
    delayMicroseconds(200);
  }
}

static void logWriteFailThrottled(const __FlashStringHelper* what) {
  unsigned long nowMs = millis();
  if (nowMs - lastWriteFailLogMs < WRITE_FAIL_LOG_THROTTLE_MS) return;
  lastWriteFailLogMs = nowMs;

  Serial.print(F("debug: mouse write failed (timeout) during "));
  Serial.println(what);
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

  buttons[0] = buttons[1] = buttons[2] = 0;
  delta_x = delta_y = 0;
  last_x = last_y = 0;
}

void loop() {
  // Check the power status (driven by keyboard Arduino pin 5)
  bool currentPowerStatus = (digitalRead(POWER_STATUS_PIN) == HIGH);
  if (currentPowerStatus != lastPowerStatus) {
    if (currentPowerStatus) {
      isPCPoweredOn = true;
      Serial.println(F("debug: mouse observed POWER_STATUS_PIN HIGH (PC power ON signal from keyboard)"));
    } else {
      isPCPoweredOn = false;
      isInitialized = false;
      isReporting = false; // safest default on power-off
      buttons[0] = buttons[1] = buttons[2] = 0;
      delta_x = delta_y = 0;
      Serial.println(F("debug: mouse observed POWER_STATUS_PIN LOW (PC power OFF signal from keyboard)"));
    }
    lastPowerStatus = currentPowerStatus;
  }

  // Process Serial Commands (from orchestrator via USB serial)
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "identify") {
      isIdentified = false;
      Serial.println(ID);
    } else if (!isIdentified && command == "identify_complete") {
      isIdentified = true;
      Serial.println(F("debug: mouse identification complete"));
    } else if (isIdentified && isPCPoweredOn) {
      // Only accept injection commands (MOVE/CLICK/RELEASE) when the shared power signal says "ON".
      if (command.startsWith("MOVE ")) {
        int commaIndex = command.indexOf(',');
        int new_x = command.substring(5, commaIndex).toInt();
        int new_y = command.substring(commaIndex + 1).toInt();

        // Calculate deltas
        delta_x = new_x - last_x;
        delta_y = new_y - last_y;

        // Clamp deltas to [-255, 255]
        if (delta_x > 255) delta_x = 255;
        if (delta_x < -255) delta_x = -255;
        if (delta_y > 255) delta_y = 255;
        if (delta_y < -255) delta_y = -255;

        last_x = new_x;
        last_y = new_y;

        if (isReporting && (delta_x != 0 || delta_y != 0)) {
          write_packet(false);
        }
      } else if (command.startsWith("CLICK ")) {
        int button = command.substring(6).toInt();
        if (button >= 0 && button < 3) {
          buttons[button] = 1;
          if (isReporting) write_packet(false);
          Serial.print(F("debug: mouse button "));
          Serial.print(button);
          Serial.println(F(" held"));
        }
      } else if (command.startsWith("RELEASE ")) {
        int button = command.substring(8).toInt();
        if (button >= 0 && button < 3) {
          buttons[button] = 0;
          if (isReporting) write_packet(false);
          Serial.print(F("debug: mouse button "));
          Serial.print(button);
          Serial.println(F(" released"));
        }
      }
    }

    // once identified, inform any serial commands have completed to prevent flooding
    if (isIdentified) {
      Serial.println("done: with command " + String(command));
    }
  }

  // IMPORTANT FIX:
  // Always service PS/2 host communication when activity is present.
  // Do NOT gate this on isPCPoweredOn; otherwise boot-time init (0xFF/0xF4) can be missed.
  if (digitalRead(PS2_CLOCK_PIN) == LOW || digitalRead(PS2_DATA_PIN) == LOW) {
    handlePS2Communication();
  }
}

void handlePS2Communication() {
  unsigned char command;
  if (mouse.read(&command) == 0) {
    mouse_command(command);
  }
}

void mouse_command(unsigned char command) {
  unsigned char val;
  switch (command) {
    case 0xFF: // Reset
      ack();
      // Reset defaults: reporting disabled
      isReporting = false;
      buttons[0] = buttons[1] = buttons[2] = 0;
      delta_x = delta_y = 0;

      while (mouse.write(0xAA) != 0); // Self-test passed
      while (mouse.write(0x00) != 0); // Mouse ID
      isInitialized = true;
      Serial.println(F("debug: mouse sent reset"));
      break;

    case 0xFE: // Resend
      ack();
      Serial.println(F("debug: mouse sent resend"));
      break;

    case 0xF6: // Set defaults
      ack();
      // Defaults include reporting disabled
      isReporting = false;
      Serial.println(F("debug: mouse sent set defaults"));
      break;

    case 0xF5: // Disable data reporting
      isReporting = false;
      ack();
      Serial.println(F("debug: mouse sent disable data reporting"));
      break;

    case 0xF4: // Enable data reporting
      isReporting = true;
      ack();
      Serial.println(F("debug: mouse sent enable data reporting"));
      break;

    case 0xF3: // Set sample rate
      ack();
      if (mouse.read(&val) == 0) {
        ack();
      }
      Serial.println(F("debug: mouse sent set sample rate"));
      break;

    case 0xF2: // Get device ID
      ack();
      while (mouse.write(0x00) != 0); // Mouse ID
      Serial.println(F("debug: mouse sent ps2 identify"));
      break;

    case 0xF0: // Set remote mode
      ack();
      Serial.println(F("debug: mouse sent remote mode"));
      break;

    case 0xEE: // Set wrap mode
      ack();
      Serial.println(F("debug: mouse sent set wrap mode"));
      break;

    case 0xEC: // Reset wrap mode
      ack();
      Serial.println(F("debug: mouse sent reset wrap mode"));
      break;

    case 0xEB: // Read data (remote mode)
      ack();
      write_packet(true); // force send in response to host request
      Serial.println(F("debug: mouse sent read data"));
      break;

    case 0xEA: // Set stream mode
      ack();
      Serial.println(F("debug: mouse sent set stream mode"));
      break;

    case 0xE9: // Status request
      ack();
      send_status();
      Serial.println(F("debug: mouse sent status"));
      break;

    case 0xE8: // Set resolution
      ack();
      if (mouse.read(&val) == 0) {
        ack();
      }
      Serial.println(F("debug: mouse sent resolution"));
      break;

    case 0xE7: // Set scaling 2:1
      ack();
      Serial.println(F("debug: mouse sent scaling 2:1"));
      break;

    case 0xE6: // Set scaling 1:1
      ack();
      break;

    default:
      // Resend for unknown command
      mouse.write(0xFE);
      Serial.println(F("debug: mouse sent command was unknown"));
      break;
  }
}

void write_packet(bool forceSend) {
  if (!forceSend && !isReporting) return;

  char overflowx = 0;
  char overflowy = 0;
  uint8_t data0;
  uint8_t data1;
  uint8_t data2;

  int x = delta_x;
  int y = delta_y;

  if (x > 255) { overflowx = 1; x = 255; }
  else if (x < -255) { overflowx = 1; x = -255; }

  if (y > 255) { overflowy = 1; y = 255; }
  else if (y < -255) { overflowy = 1; y = -255; }

  // PS/2 packet:
  // bit0 L, bit1 R, bit2 M, bit3 always 1,
  // bit4 X sign, bit5 Y sign, bit6 X overflow, bit7 Y overflow
  data0 = ((overflowy & 1) << 7) |
          ((overflowx & 1) << 6) |
          ((((y & 0x100) >> 8) & 1) << 5) |
          ((((x & 0x100) >> 8) & 1) << 4) |
          ((1) << 3) |
          ((buttons[2] & 1) << 2) |  // middle
          ((buttons[1] & 1) << 1) |  // right
          ((buttons[0] & 1) << 0);   // left

  data1 = (uint8_t)(x & 0xFF);
  data2 = (uint8_t)(y & 0xFF);

  bool ok0 = writeByteWithRetry(data0);
  bool ok1 = ok0 ? writeByteWithRetry(data1) : false;
  bool ok2 = ok1 ? writeByteWithRetry(data2) : false;

  if (!ok0 || !ok1 || !ok2) {
    logWriteFailThrottled(F("write_packet"));
  }

  delta_x = 0;
  delta_y = 0;
}

void ack() {
  while (mouse.write(0xFA) != 0);
}

void send_status() {
  // Basic status packet
  unsigned char status0 = 0x00;
  unsigned char status1 = 0x00;
  unsigned char status2 = 0x00;

  // Use bounded retries to avoid silent loss
  if (!writeByteWithRetry(status0)) logWriteFailThrottled(F("send_status[0]"));
  if (!writeByteWithRetry(status1)) logWriteFailThrottled(F("send_status[1]"));
  if (!writeByteWithRetry(status2)) logWriteFailThrottled(F("send_status[2]"));
}
