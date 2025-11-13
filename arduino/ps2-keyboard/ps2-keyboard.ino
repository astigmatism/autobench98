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
unsigned char lastByte; // Variable to store the last sent byte

void setup() {
  keyboard.keyboard_init();
  Serial.begin(9600);
  Serial.flush();
  pinMode(POWER_STATUS_PIN, OUTPUT);
  pinMode(PS2_CLOCK_PIN, INPUT_PULLUP);
  pinMode(PS2_DATA_PIN, INPUT_PULLUP);
}

void loop() {
  // Monitor the PS/2 clock line to detect communication from the host
  if (digitalRead(PS2_CLOCK_PIN) == LOW) {
    handlePS2Communication();
  }

  // Process Serial Commands
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    if (command == "identify") {
      isIdentified = false;
      Serial.println(ID);
    } else if (!isIdentified && command == "identify_complete") {
      isIdentified = true;
      Serial.println("debug: keyboard identification complete");
    }
    else if (isIdentified && command == "power_on") {
      isPCPoweredOn = true;
      digitalWrite(POWER_STATUS_PIN, HIGH);
      Serial.println("debug: keyboard accepts power ON command, sets PIN " + String(POWER_STATUS_PIN) + " to HIGH");
    }
    else if (isIdentified && command == "power_off") {
      isPCPoweredOn = false;
      isInitialized = false;
      digitalWrite(POWER_STATUS_PIN, LOW);
      Serial.println("debug: keyboard accepts power OFF command, sets PIN " + String(POWER_STATUS_PIN) + " to LOW");
    }
    else if (isIdentified) {
      int spaceIndex = command.indexOf(' ');
      String action = command.substring(0, spaceIndex);
      String scanCodeStr = command.substring(spaceIndex + 1);
      int colonIndex = scanCodeStr.indexOf(':');
      unsigned char prefix = 0x00;
      unsigned char scanCode;

      if (colonIndex != -1) {
        // Handle prefix
        String prefixStr = scanCodeStr.substring(0, colonIndex);
        prefix = (unsigned char)strtol(prefixStr.c_str(), NULL, 16);
        scanCodeStr = scanCodeStr.substring(colonIndex + 1);
      }
      scanCode = (unsigned char)strtol(scanCodeStr.c_str(), NULL, 16);
      
      if (action == "press" || action == "hold" || action == "release") {
        if (action == "press" || action == "hold") {
          if (prefix != 0x00) {
            keyboard.keyboard_press(prefix);
          }
          keyboard.keyboard_press(scanCode);
          if (action == "press") {
            delay(100); // Adjust this delay to control how long the key is held
            if (prefix != 0x00) {
              keyboard.keyboard_release(prefix);
            }
            keyboard.keyboard_release(scanCode);
          }
        } else if (isIdentified && action == "release") {
          if (prefix != 0x00) {
            keyboard.keyboard_release(prefix);
          }
          keyboard.keyboard_release(scanCode);
        }
        Serial.println("success: " + action + " command for scan code " + String(scanCode, HEX));
      }
    }
    else {
      Serial.println("debug: command is " + command + ". nothing to do");
    }
  }
}

void handlePS2Communication() {
  unsigned char command;
  // Serial.println("debug: keyboard reading input...");
  if (keyboard.read(&command) == 0) { // ensures that the read operation was successful and that the command variable contains a valid command
    Serial.println("debug: keyboard sim recieved 0x" + String(command, HEX));
    keyboard_command(command);
  } else {
    Serial.println("debug: keyboard sim recieved unknown: " + String(command, HEX));
  }
}

void keyboard_command(unsigned char command) {
  unsigned char val;
  switch (command) {
    case 0xFF: // Reset
      Serial.println("debug: handling reset command");
      ack();
      delay(600); // Wait for 600 milliseconds to simulate BAT duration
      while (keyboard.write(0xAA) != 0) delay(1); // Send BAT_SUCCESS
      Serial.println("debug: sent BAT success");
      lastByte = 0xAA;
      break;
    case 0xFE: // Resend
      Serial.println("debug: handling resend command");
      keyboard.write(lastByte); // Resend the last byte
      break;
    case 0xF2: // Identify
      {
        Serial.println("debug: handling identify command");
        ack();
        int retryCount = 0;
        const int maxRetries = 100; // Maximum number of retries
        do {
          if (keyboard.write(0xAB) == 0) { // Send keyboard ID byte 1
            lastByte = 0xAB;
            if (keyboard.write(0x83) == 0) { // Send keyboard ID byte 2
              lastByte = 0x83;
              break; // Both bytes were written successfully
            }
          }
          retryCount++;
        } while (retryCount < maxRetries);
        break;
      }
    case 0xED: // Set/Reset LEDs
      Serial.println("debug: handling set/reset LEDs command");
      ack();
      if (keyboard.read(&val) == 0) {
        ack();
        // Process LED state changes based on `val`
        // Example: updateLEDs(val);
      }
      Serial.println("debug: keyboard sim sent LED state change");
      break;
    case 0xEE: // Echo
      Serial.println("debug: keyboard sim handling echo");
      keyboard.write(0xEE); // Echo back
      lastByte = 0xEE;
      break;
    case 0xF0: // Set scan code set
      Serial.println("debug: keyboard sim handling scan code set");
      ack();
      if (keyboard.read(&val) == 0) {
        ack();
        // Process scan code set change based on `val`
      }
      break;
    case 0xF3: // Set typematic rate
      Serial.println("debug: keyboard sim handling typematic rate");
      ack();
      if (keyboard.read(&val) == 0) {
        ack();
        // Process typematic rate based on `val`
        // Example: updateTypematicRate(val);
      }
      break;
    case 0xF4: // Enable data reporting
      Serial.println("debug: keyboard handling enable scanning");
      ack();
      break;
    case 0xF5: // Disable data reporting
      Serial.println("debug: keyboard handling disable scanning");
      ack();
      break;
    case 0xF6: // Set defaults
      Serial.println("debug: keyboard set defaults");
      ack();
      break;
    default:
      Serial.println("debug: received unknown command " + String(command, HEX));
      ack();
      break;
  }
}

void ack() {
  Serial.println("debug: acknowledge");
  while (keyboard.write(0xFA) != 0) delay(1); // Send ACK
  lastByte = 0xFA;
}
