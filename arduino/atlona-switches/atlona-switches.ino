#include <Arduino.h>

#define ID "AC"

// Define switch pin pairs
const int switchPins[3][2] = {
  {2, 3},  // Switch 1: connected between pins 2 and 3
  {4, 5},  // Switch 2: connected between pins 4 and 5
  {6, 7}   // Switch 3: connected between pins 6 and 7
};

bool lastSwitchStates[3] = {false, false, false};  // Last states of the switches
bool isIdentified = false;                         // Identification flag

void setup() {
  Serial.begin(9600);
  // Initialize all switch pins as INPUT_PULLUP
  for (int i = 0; i < 3; i++) {
    pinMode(switchPins[i][0], INPUT_PULLUP);
    pinMode(switchPins[i][1], INPUT_PULLUP);
  }
}

void loop() {
  // Check each switch (placeholder for future reporting if needed)
  for (int i = 0; i < 3; i++) {
    // Read the current state of the switch
    bool currentSwitchState = !digitalRead(switchPins[i][0]) && !digitalRead(switchPins[i][1]);

    // Check if the state has changed from the last iteration
    if (currentSwitchState != lastSwitchStates[i]) {
      lastSwitchStates[i] = currentSwitchState;  // Update the last state
      // Optionally: report state changes over Serial if required later
      // if (isIdentified) {
      //   Serial.print("SWITCH_");
      //   Serial.print(i + 1);
      //   Serial.println(currentSwitchState ? "_ON" : "_OFF");
      // }
    }
  }

  // Handle serial commands
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();

    // Identification handshake
    if (input == "identify") {
      isIdentified = false;
      Serial.println(ID);
    } else if (!isIdentified && input == "identify_complete") {
      isIdentified = true;
      Serial.println("debug: accessory controller identification complete");
    }
    // Only accept control commands once identified
    else if (isIdentified && input.startsWith("hold ")) {
      int switchNum = input.substring(5).toInt() - 1;
      if (switchNum >= 0 && switchNum < 3) {
        Serial.print("debug: pressing switch ");
        Serial.println(switchNum + 1);
        // Set both pins of the switch to OUTPUT and LOW to simulate holding
        pinMode(switchPins[switchNum][0], OUTPUT);
        pinMode(switchPins[switchNum][1], OUTPUT);
        digitalWrite(switchPins[switchNum][0], LOW);
        digitalWrite(switchPins[switchNum][1], LOW);
      } else {
        Serial.println("debug: invalid switch number for hold command");
      }
    } else if (isIdentified && input.startsWith("release ")) {
      int switchNum = input.substring(8).toInt() - 1;
      if (switchNum >= 0 && switchNum < 3) {
        Serial.print("debug: releasing switch ");
        Serial.println(switchNum + 1);
        // Set both pins of the switch back to INPUT_PULLUP to simulate releasing
        pinMode(switchPins[switchNum][0], INPUT_PULLUP);
        pinMode(switchPins[switchNum][1], INPUT_PULLUP);
      } else {
        Serial.println("debug: invalid switch number for release command");
      }
    } else if (!isIdentified) {
      // Command received before identification is complete
      Serial.println("debug: command ignored, accessory controller not yet identified");
    }
  }

  delay(100);  // Add a small delay to reduce serial processing rate
}